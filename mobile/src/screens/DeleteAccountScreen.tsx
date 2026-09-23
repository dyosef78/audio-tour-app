import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { DeleteAccountScreenProps } from '../navigation/types';
import { deleteAccount } from '../services/auth/AccountService';
import type { DeleteAccountOutcome, DeletionFailureReason, DeletionOptions } from '../services/auth/accountDeletion';
import { hasProvider, useAuth } from '../services/auth/authStore';
import { colors } from '../ui/theme';

const FAILURE: Record<DeletionFailureReason, { title: string; message: string }> = {
  offline: {
    title: "You're offline",
    message: 'Connect to the internet and try again. Nothing has been deleted.',
  },
  session_expired: {
    title: 'Signed out',
    message:
      "Your sign-in had expired, so you've been signed out. If you'd already deleted your account, it's gone. Otherwise, sign in again from Settings and retry.",
  },
  admin_account: {
    title: "Can't delete this account",
    message: 'This is a content administrator account and cannot be deleted from the app. Please ask the Audio Tour team to remove it.',
  },
  server: {
    title: 'Account not deleted',
    message: 'Something went wrong on our side and nothing was deleted. Please try again in a moment.',
  },
  timeout: {
    title: "Couldn't confirm",
    message:
      "We couldn't confirm your account was deleted - the connection may be slow. It's safe to try again; if it was already deleted, you'll simply be signed out.",
  },
  apple_confirmation: {
    title: "Apple confirmation didn't finish",
    message:
      "Your account has NOT been deleted and you're still signed in. You can try Apple again, or delete without it - your account is deleted either way, but Apple may keep listing Audio Tour under your Apple ID until you remove it in iOS Settings.",
  },
};

/**
 * Confirmation is INLINE, never a UIAlertController in front of the Apple sheet
 * (device QA, 23 Sep: the sheet hung or re-prompted after Face ID when it was
 * presented straight after an alert's dismissal, while the identical call from a
 * plain button tap - the sign-in - works). The confirm button only becomes
 * active this long after arming, so one double-tap cannot arm and confirm.
 */
const ARM_DELAY_MS = 600;
/** Lets the guard's navigation reset settle before the "deleted" alert is presented over Discovery. */
const CONFIRMATION_DELAY_MS = 450;

/**
 * Delete account (TASK-1104, App Store Review Guideline 5.1.1(v)).
 *
 * Says plainly what goes and what stays, asks once more, then deletes
 * immediately - no email, no waiting period, no support contact. Apple users
 * confirm with Apple as the final step (see accountDeletion.ts). The outcome is
 * shown before leaving, so a person is never left guessing whether it worked.
 *
 * NEVER STUCK (Epic 11 device-QA fix). deleteAccount() settles in bounded time
 * and never rejects; `finally` unlocks the screen regardless, and a ref stops a
 * second tap from starting a second deletion while the first is in flight.
 *
 * NEVER SILENT (second device-QA pass). Every outcome shows something. A failed
 * Apple sheet - including iOS's own failures reported as "canceled" - says the
 * account was NOT deleted and offers "Delete without Apple", so a sheet that
 * keeps failing cannot trap anyone. The Apple sheet is only ever presented by a
 * tap, never by a re-render or a retry loop.
 */
export default function DeleteAccountScreen({ navigation }: DeleteAccountScreenProps) {
  const insets = useSafeAreaInsets();
  // Primary OR linked identity - the same test the deletion flow uses.
  const appleIdentity = useAuth((s) => hasProvider(s.account, 'apple'));
  const googleIdentity = useAuth((s) => hasProvider(s.account, 'google'));
  const signedIn = useAuth((s) => s.status === 'signed_in');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; reference: string | null } | null>(null);
  const inFlight = useRef(false);
  // Two-step, on this screen: 'idle' -> tap -> 'arming' -> ARM_DELAY_MS -> 'armed' -> tap -> run.
  const [confirmStep, setConfirmStep] = useState<'idle' | 'arming' | 'armed'>('idle');
  const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(armTimer.current), []);

  const arm = () => {
    clearTimeout(armTimer.current);
    setConfirmStep('arming');
    armTimer.current = setTimeout(() => setConfirmStep('armed'), ARM_DELAY_MS);
  };
  const disarm = () => {
    clearTimeout(armTimer.current);
    setConfirmStep('idle');
  };

  const run = async (options: DeletionOptions = {}) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setMessage(null);
    setBusy(true);

    disarm();

    let outcome: DeleteAccountOutcome;
    try {
      // Called from a direct button tap (or from the failure alert's "Delete
      // without Apple", which presents no sheet). AccountService waits for the
      // app to be active and idle before it presents the Apple sheet.
      outcome = await deleteAccount(options);
    } catch (err) {
      console.warn('[Account] unexpected deletion error:', err);
      outcome = { kind: 'failed', reason: 'server', detail: 'SCREEN_EXCEPTION' };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }

    if (outcome.kind === 'failed') {
      const { title, message: text } = FAILURE[outcome.reason];
      // The reference goes IN the alert, not only on the screen behind it: in
      // device QA the tester read the alert, and the reference was not in it.
      // Client-side failures leave no server log; this line is the evidence.
      const reference = outcome.detail ? `${outcome.reason} / ${outcome.detail}` : outcome.reason;
      setMessage({ text, reference });
      const body = `${text}\n\nReference: ${reference}`;
      if (outcome.reason === 'apple_confirmation') {
        Alert.alert(title, body, [
          { text: 'Keep my account', style: 'cancel' },
          // Re-arms the button on this screen - the next Apple sheet opens from a
          // plain tap again, never straight out of this alert.
          { text: 'Try Apple again', onPress: arm },
          { text: 'Delete without Apple', style: 'destructive', onPress: () => void run({ skipAppleConfirmation: true }) },
        ]);
      } else {
        Alert.alert(title, body);
      }
      return;
    }
    // NAVIGATION IS NOT THIS SCREEN'S JOB (device QA, 23 Sep). The deletion flow
    // purged the auth state synchronously before its first await, and the
    // account-route guard in RootNavigator reset to Discovery inside that same
    // setState - so by the time this line runs, this screen is normally already
    // gone. This is only a fallback, and a loud one: reaching it means the guard
    // did not fire (e.g. the state was already signed_out).
    if (navigation.isFocused()) {
      console.warn('[Account] deleted, but the auth guard did not leave DeleteAccount; resetting directly');
      navigation.reset({ index: 0, routes: [{ name: 'Discovery' }] });
    }

    // Confirm on the guest Discovery screen. For Apple and Google accounts, and
    // whenever the local teardown was not clean, show the evidence QA needs.
    const lines = [
      appleIdentity
        ? `Apple code sent: ${outcome.appleCodeSent ? 'yes' : 'no'} / revocation: ${outcome.appleRevocation ?? 'unknown'}`
        : null,
      googleIdentity
        ? `Google token: ${outcome.googleToken ?? 'not requested'} / revocation: ${outcome.googleRevocation ?? 'unknown'}`
        : null,
      outcome.localTeardown !== 'clean' ? `Local sign-out: ${outcome.localTeardown}` : null,
    ].filter((line): line is string => line !== null);
    const reference = lines.length > 0 ? `\n\nReference: ${lines.join(' / ')}` : '';
    setTimeout(() => {
      Alert.alert(
        'Account deleted',
        `Your account and its data have been deleted. You can keep using Audio Tour without an account.${reference}`,
      );
    }, CONFIRMATION_DELAY_MS);
  };

  const disabled = busy || !signedIn;
  const primaryLabel =
    confirmStep === 'idle' ? 'Delete account' : appleIdentity ? 'Confirm with Apple and delete' : 'Yes, delete my account';

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title} accessibilityRole="header">
          Delete your account
        </Text>
        <Text style={styles.body}>Your account is deleted straight away and can't be recovered.</Text>

        <Text style={styles.section}>WHAT'S DELETED</Text>
        <Bullet>Your account, and the name and email address it holds</Bullet>
        <Bullet>
          Its connection to your {appleIdentity && googleIdentity ? 'Apple and Google' : appleIdentity ? 'Apple' : googleIdentity ? 'Google' : 'sign-in'} account
        </Bullet>
        <Bullet>Anything saved to your account</Bullet>

        <Text style={styles.section}>WHAT STAYS ON THIS PHONE</Text>
        <Bullet>Tours you've downloaded, and your tour preferences. They were never tied to your account; you can keep using the app without one.</Bullet>

        <Text style={styles.note}>
          Anonymous usage statistics use a random ID on this device and aren't connected to your account, so there is nothing
          of yours in them to delete.
        </Text>

        {message !== null && (
          <View style={styles.messageBox} accessibilityRole="alert">
            <Text style={styles.message}>{message.text}</Text>
            {message.reference !== null && <Text style={styles.reference}>Reference: {message.reference}</Text>}
          </View>
        )}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 14 }]}>
        {confirmStep !== 'idle' && !busy && (
          <Text style={styles.confirmNote} accessibilityRole="alert">
            {appleIdentity
              ? "This can't be undone. Apple will ask you to confirm one last time."
              : "This can't be undone."}
          </Text>
        )}
        <Pressable
          onPress={confirmStep === 'armed' ? () => void run() : arm}
          disabled={disabled || confirmStep === 'arming'}
          accessibilityRole="button"
          accessibilityState={{ disabled: disabled || confirmStep === 'arming', busy }}
          style={({ pressed }) => [
            styles.delete,
            (disabled || confirmStep === 'arming') && styles.deleteDisabled,
            pressed && styles.pressed,
          ]}
        >
          {busy ? <ActivityIndicator color={colors.canvas} /> : <Text style={styles.deleteText}>{primaryLabel}</Text>}
        </Pressable>
        <Pressable
          onPress={confirmStep === 'idle' ? () => navigation.goBack() : disarm}
          disabled={busy}
          accessibilityRole="button"
          style={styles.keep}
        >
          <Text style={styles.keepText}>{confirmStep === 'idle' ? 'Keep my account' : 'Cancel'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Bullet({ children }: { children: ReactNode }) {
  return (
    <View style={styles.bullet}>
      <Text style={styles.dot} importantForAccessibility="no" accessibilityElementsHidden>
        •
      </Text>
      <Text style={styles.bulletText}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  content: { padding: 20, paddingBottom: 32 },
  title: { fontSize: 26, fontWeight: '700', color: colors.ink },
  body: { fontSize: 16, lineHeight: 22, color: colors.ink, marginTop: 8 },
  section: { fontSize: 12, fontWeight: '700', letterSpacing: 0.8, color: colors.inkSecondary, marginTop: 24, marginBottom: 6 },
  bullet: { flexDirection: 'row', gap: 8, marginTop: 6 },
  dot: { fontSize: 16, lineHeight: 22, color: colors.inkSecondary },
  bulletText: { flex: 1, fontSize: 15, lineHeight: 22, color: colors.ink },
  note: { fontSize: 13, lineHeight: 18, color: colors.inkSecondary, marginTop: 20 },
  messageBox: { marginTop: 20, gap: 6 },
  message: { fontSize: 15, lineHeight: 21, color: colors.dangerInk },
  reference: { fontSize: 12, color: colors.inkSecondary },
  footer: {
    paddingHorizontal: 20, paddingTop: 12, gap: 4,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline,
  },
  delete: { minHeight: 54, borderRadius: 14, backgroundColor: colors.dangerInk, alignItems: 'center', justifyContent: 'center' },
  deleteDisabled: { opacity: 0.5 },
  pressed: { opacity: 0.85 },
  deleteText: { color: colors.canvas, fontSize: 17, fontWeight: '700' },
  keep: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  confirmNote: { fontSize: 14, lineHeight: 20, color: colors.dangerInk, textAlign: 'center', marginBottom: 4 },
  keepText: { fontSize: 16, fontWeight: '600', color: colors.accent },
});
