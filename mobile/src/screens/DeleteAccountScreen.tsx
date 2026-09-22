import { useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { DeleteAccountScreenProps } from '../navigation/types';
import { deleteAccount } from '../services/auth/AccountService';
import type { DeleteAccountOutcome, DeletionFailureReason, DeletionOptions } from '../services/auth/accountDeletion';
import { useAuth } from '../services/auth/authStore';
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

/** Lets our confirmation dialog finish dismissing before iOS is asked to present the Apple sheet. */
const ALERT_DISMISS_MS = 300;

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
  const provider = useAuth((s) => s.account?.provider ?? null);
  const signedIn = useAuth((s) => s.status === 'signed_in');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; reference: string | null } | null>(null);
  const inFlight = useRef(false);

  const run = async (options: DeletionOptions = {}) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setMessage(null);
    setBusy(true);

    let outcome: DeleteAccountOutcome;
    try {
      // Only needed when an Apple sheet is about to be presented over our dialog.
      if (provider === 'apple' && !options.skipAppleConfirmation) {
        await new Promise((resolve) => setTimeout(resolve, ALERT_DISMISS_MS));
      }
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
      // A short reference ("apple_confirmation / ERR_REQUEST_CANCELED") so a
      // tester can report WHICH branch ran - client failures leave no server log.
      setMessage({ text, reference: outcome.detail ? `${outcome.reason} / ${outcome.detail}` : outcome.reason });
      if (outcome.reason === 'apple_confirmation') {
        Alert.alert(title, text, [
          { text: 'Keep my account', style: 'cancel' },
          { text: 'Try Apple again', onPress: () => void run() },
          { text: 'Delete without Apple', style: 'destructive', onPress: () => void run({ skipAppleConfirmation: true }) },
        ]);
      } else {
        Alert.alert(title, text);
      }
      return;
    }
    Alert.alert('Account deleted', 'Your account and its data have been deleted. You can keep using Audio Tour without an account.', [
      { text: 'OK', onPress: () => navigation.reset({ index: 0, routes: [{ name: 'Discovery' }] }) },
    ]);
  };

  const confirm = () => {
    Alert.alert(
      'Delete your account?',
      provider === 'apple'
        ? "This can't be undone. You'll confirm with Apple one last time."
        : "This can't be undone.",
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void run() },
      ],
    );
  };

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title} accessibilityRole="header">
          Delete your account
        </Text>
        <Text style={styles.body}>Your account is deleted straight away and can't be recovered.</Text>

        <Text style={styles.section}>WHAT'S DELETED</Text>
        <Bullet>Your account, and the name and email address it holds</Bullet>
        <Bullet>Its connection to your {provider === 'google' ? 'Google' : provider === 'apple' ? 'Apple' : 'sign-in'} account</Bullet>
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
        <Pressable
          onPress={confirm}
          disabled={busy || !signedIn}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy || !signedIn, busy }}
          style={({ pressed }) => [styles.delete, (busy || !signedIn) && styles.deleteDisabled, pressed && styles.pressed]}
        >
          {busy ? <ActivityIndicator color={colors.canvas} /> : <Text style={styles.deleteText}>Delete account</Text>}
        </Pressable>
        <Pressable onPress={() => navigation.goBack()} disabled={busy} accessibilityRole="button" style={styles.keep}>
          <Text style={styles.keepText}>Keep my account</Text>
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
  keepText: { fontSize: 16, fontWeight: '600', color: colors.accent },
});
