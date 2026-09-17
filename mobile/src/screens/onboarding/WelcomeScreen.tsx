import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import SignInButtons from '../../components/auth/SignInButtons';
import type { WelcomeScreenProps } from '../../navigation/types';
import { refreshCities, refreshCitiesWithin, useCityCatalogue } from '../../personalization/cityCatalogue';
import { resolveCity } from '../../personalization/onboardingFlow';
import { usePreferences } from '../../personalization/preferencesStore';
import { useAuth } from '../../services/auth/authStore';
import { colors, MIN_TOUCH } from '../../ui/theme';

/** How long "Continue" may wait for the city list before moving on without it. */
const CITY_WAIT_MS = 2000;

const FEATURES = [
  { icon: '🎧', text: 'Narration starts as you reach each stop' },
  { icon: '📴', text: 'Download a tour and walk it offline' },
  { icon: '🧭', text: 'A route shaped around your interests' },
] as const;

/**
 * Welcome and optional sign-in (TASK-1101; auth from TASK-1102).
 *
 * GUEST-FIRST (PM, Epic 11). "Continue without account" is the primary action,
 * and nothing about the app is locked behind the buttons above it. An account
 * gives no user-facing feature in the MVP (PM, 18 Sep), so the copy promises
 * none.
 *
 * Not a numbered step. Leaving it resets the stack, so Back from the first step
 * cannot return here after signing in. Sign-in stays available later from
 * Settings.
 */
export default function WelcomeScreen({ navigation }: WelcomeScreenProps) {
  const insets = useSafeAreaInsets();
  const auth = useAuth();
  const markWelcomeSeen = usePreferences((s) => s.markWelcomeSeen);

  const [continuing, setContinuing] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  const signedIn = auth.status === 'signed_in';

  useEffect(() => {
    // Warm the city list now, so Continue rarely has to wait for it.
    void refreshCities();
  }, []);

  const proceed = async (): Promise<void> => {
    setContinuing(true);
    await refreshCitiesWithin(CITY_WAIT_MS);
    const prefs = usePreferences.getState();
    const resolution = resolveCity(useCityCatalogue.getState().cities, prefs.cityId);
    if (resolution.kind === 'auto') prefs.setCity(resolution.cityId);
    markWelcomeSeen();

    if (prefs.onboardingComplete) {
      navigation.reset({ index: 0, routes: [{ name: 'Discovery' }] });
      return;
    }
    const includeCity = resolution.kind === 'choose';
    navigation.reset({
      index: 0,
      routes: [{ name: includeCity ? 'OnboardingCity' : 'OnboardingGroup', params: { includeCity } }],
    });
  };

  const disabled = continuing || signingIn;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.hero}>
        <View style={styles.mark} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <Text style={styles.markGlyph}>🎧</Text>
        </View>
        <Text style={styles.title} accessibilityRole="header">
          Hear the city as you walk it
        </Text>
        <Text style={styles.subtitle}>
          Audio stories that play as you arrive at each stop, so your phone can stay in your pocket.
        </Text>

        <View style={styles.features}>
          {FEATURES.map((f) => (
            <View key={f.text} style={styles.feature}>
              <Text style={styles.featureIcon} importantForAccessibility="no" accessibilityElementsHidden>
                {f.icon}
              </Text>
              <Text style={styles.featureText}>{f.text}</Text>
            </View>
          ))}
        </View>
      </ScrollView>

      <View style={[styles.panel, { paddingBottom: insets.bottom + 14 }]}>
        {signedIn ? (
          <Text style={styles.signedIn}>
            Signed in{auth.account?.displayName ? ` as ${auth.account.displayName}` : ''}
          </Text>
        ) : (
          <SignInButtons onSignedIn={() => void proceed()} onBusyChange={setSigningIn} disabled={continuing} />
        )}

        <Pressable
          onPress={() => void proceed()}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityState={{ disabled, busy: continuing }}
          style={({ pressed }) => [styles.cta, pressed && !disabled && styles.ctaPressed]}
        >
          {continuing ? (
            <ActivityIndicator color={colors.canvas} />
          ) : (
            <Text style={styles.ctaText}>{signedIn ? 'Continue' : 'Continue without account'}</Text>
          )}
        </Pressable>
        {!signedIn && <Text style={styles.fineprint}>No account needed. Every tour works without one.</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  hero: { paddingHorizontal: 24, paddingTop: 40, paddingBottom: 24 },
  mark: {
    width: 88, height: 88, borderRadius: 44, backgroundColor: colors.accentSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  markGlyph: { fontSize: 44 },
  title: { fontSize: 32, lineHeight: 38, fontWeight: '800', color: colors.ink, marginTop: 24 },
  subtitle: { fontSize: 17, lineHeight: 24, color: colors.inkMuted, marginTop: 10 },
  features: { marginTop: 28, gap: 14 },
  feature: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  featureIcon: { fontSize: 22, width: 32, textAlign: 'center' },
  featureText: { flex: 1, fontSize: 16, lineHeight: 22, color: colors.ink },

  panel: {
    paddingHorizontal: 20, paddingTop: 16, gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline, backgroundColor: colors.canvas,
  },
  signedIn: { fontSize: 15, fontWeight: '600', color: colors.accent, textAlign: 'center' },
  cta: {
    minHeight: 54, borderRadius: 14, backgroundColor: colors.ink,
    alignItems: 'center', justifyContent: 'center', minWidth: MIN_TOUCH,
  },
  ctaPressed: { opacity: 0.85 },
  ctaText: { color: colors.canvas, fontSize: 17, fontWeight: '700' },
  fineprint: { fontSize: 13, color: colors.inkMuted, textAlign: 'center' },
});
