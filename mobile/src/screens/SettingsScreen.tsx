import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import SignInButtons from '../components/auth/SignInButtons';
import type { SettingsScreenProps } from '../navigation/types';
import { useCityCatalogue } from '../personalization/cityCatalogue';
import { GROUP_TYPES, INTERESTS, TIME_BUDGETS, labelFor } from '../personalization/options';
import { usePreferences } from '../personalization/preferencesStore';
import { useAuth } from '../services/auth/authStore';
import { signOut } from '../services/auth/sessionTeardown';
import { colors, MIN_TOUCH } from '../ui/theme';

const PROVIDER_LABEL: Record<string, string> = { apple: 'Apple', google: 'Google' };

/**
 * Settings (TASK-1104): tour preferences, city and the account.
 *
 * App Store Review Guideline 5.1.1(v) wants account deletion easy to find;
 * this is where Apple's guidance says people look: Settings > Account.
 * A guest sees sign-in here instead - the only other place it is offered after
 * Welcome.
 */
export default function SettingsScreen({ navigation }: SettingsScreenProps) {
  const auth = useAuth();
  const groupType = usePreferences((s) => s.groupType);
  const interests = usePreferences((s) => s.interests);
  const timeBudget = usePreferences((s) => s.timeBudget);
  const cityId = usePreferences((s) => s.cityId);
  const cities = useCityCatalogue((s) => s.cities);
  const [signingOut, setSigningOut] = useState(false);

  const cityName = cities?.find((c) => c.id === cityId)?.name ?? null;
  const summary = [
    groupType ? labelFor(GROUP_TYPES, groupType) : null,
    timeBudget ? labelFor(TIME_BUDGETS, timeBudget) : null,
    interests.map((i) => labelFor(INTERESTS, i)).join(', ') || null,
  ]
    .filter(Boolean)
    .join(' · ');

  // The account section switches to the guest view synchronously, inside
  // signOut(), before its first await (Epic 12) - so there is no "Signing out…"
  // to watch; `signingOut` only guards a double tap. signOut() is bounded and
  // never rejects.
  const doSignOut = async () => {
    setSigningOut(true);
    const outcome = await signOut();
    setSigningOut(false);
    if (outcome === 'incomplete') {
      // Fail loud: the stored session could not be confirmed removed, so it may
      // come back on the next launch. Say so instead of pretending.
      Alert.alert(
        'Sign-out may not be complete',
        "You're signed out for now, but this phone couldn't confirm it removed your sign-in. If you're signed in again next time you open the app, sign out once more.\n\nReference: sign_out / incomplete",
      );
    }
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.section} accessibilityRole="header">
        YOUR TOURS
      </Text>
      <View style={styles.group}>
        <Row
          label="Preferences"
          value={summary || 'Not set'}
          onPress={() => navigation.navigate('OnboardingGroup', { editing: true })}
        />
        {(cities?.length ?? 0) >= 2 && (
          <Row
            label="City"
            value={cityName ?? 'Not chosen'}
            onPress={() => navigation.navigate('OnboardingCity', { editing: true })}
          />
        )}
      </View>

      <Text style={styles.section} accessibilityRole="header">
        ACCOUNT
      </Text>
      {auth.status === 'restoring' ? (
        <View style={[styles.group, styles.padded]}>
          <ActivityIndicator />
        </View>
      ) : auth.status === 'signed_in' && auth.account ? (
        <>
          <View style={[styles.group, styles.padded]}>
            <Text style={styles.accountName}>{auth.account.displayName ?? auth.account.email ?? 'Signed in'}</Text>
            <Text style={styles.accountMeta}>
              {[auth.account.displayName ? auth.account.email : null, auth.account.provider ? `Signed in with ${PROVIDER_LABEL[auth.account.provider] ?? auth.account.provider}` : null]
                .filter(Boolean)
                .join('\n')}
            </Text>
          </View>
          <View style={styles.group}>
            <Pressable
              onPress={() => void doSignOut()}
              disabled={signingOut}
              accessibilityRole="button"
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <Text style={styles.rowAction}>{signingOut ? 'Signing out…' : 'Sign out'}</Text>
            </Pressable>
            <Pressable
              onPress={() => navigation.navigate('DeleteAccount')}
              accessibilityRole="button"
              accessibilityHint="Opens the account deletion screen"
              style={({ pressed }) => [styles.row, styles.rowBorder, pressed && styles.pressed]}
            >
              <Text style={styles.rowDanger}>Delete account</Text>
            </Pressable>
          </View>
          <Text style={styles.footnote}>Signing out or deleting your account keeps your downloaded tours and preferences on this phone.</Text>
        </>
      ) : (
        <View style={[styles.group, styles.padded, styles.guest]}>
          <Text style={styles.guestText}>You're using Audio Tour without an account. Every tour works without one.</Text>
          <SignInButtons onSignedIn={() => {}} />
        </View>
      )}
    </ScrollView>
  );
}

function Row({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue} numberOfLines={2}>
          {value}
        </Text>
      </View>
      <Text style={styles.chevron} importantForAccessibility="no" accessibilityElementsHidden>
        ›
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  content: { padding: 16, paddingBottom: 40 },
  section: { fontSize: 12, fontWeight: '700', letterSpacing: 0.8, color: colors.inkSecondary, marginTop: 16, marginBottom: 8, marginLeft: 4 },
  group: { borderRadius: 14, backgroundColor: colors.canvas, overflow: 'hidden' },
  padded: { padding: 16 },
  guest: { gap: 14 },
  guestText: { fontSize: 15, lineHeight: 21, color: colors.ink },
  row: { minHeight: MIN_TOUCH + 12, paddingHorizontal: 16, paddingVertical: 10, flexDirection: 'row', alignItems: 'center' },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
  pressed: { backgroundColor: colors.surface },
  rowLabel: { fontSize: 16, fontWeight: '600', color: colors.ink },
  rowValue: { fontSize: 14, color: colors.inkSecondary, marginTop: 2 },
  chevron: { fontSize: 24, color: colors.hairline, marginLeft: 8 },
  rowAction: { fontSize: 16, fontWeight: '600', color: colors.accent },
  rowDanger: { fontSize: 16, fontWeight: '600', color: colors.dangerInk },
  accountName: { fontSize: 17, fontWeight: '700', color: colors.ink },
  accountMeta: { fontSize: 14, lineHeight: 20, color: colors.inkSecondary, marginTop: 4 },
  footnote: { fontSize: 13, lineHeight: 18, color: colors.inkSecondary, marginTop: 8, marginHorizontal: 4 },
});
