import { GoogleSigninButton } from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { WelcomeScreenProps } from '../../navigation/types';
import { refreshCities, refreshCitiesWithin, useCityCatalogue } from '../../personalization/cityCatalogue';
import { resolveCity } from '../../personalization/onboardingFlow';
import { usePreferences } from '../../personalization/preferencesStore';
import {
  isAppleSignInAvailable,
  isGoogleSignInConfigured,
  signInWithApple,
  signInWithGoogle,
  type SignInOutcome,
} from '../../services/auth/AuthService';
import { useAuth } from '../../services/auth/authStore';
import { networkMonitor } from '../../services/network/NetworkMonitor';
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
 * and nothing about the app is locked behind the buttons above it. Sign-in
 * needs a connection; a tourist opening the app offline abroad just continues.
 * The copy promises nothing an account does not actually do today.
 *
 * Apple's and Google's own buttons are used, as both providers' guidelines
 * require. Apple is iOS-only; Google appears only in builds with client IDs.
 *
 * Not a numbered step. Leaving it resets the stack, so Back from the first step
 * cannot return here after signing in.
 */
export default function WelcomeScreen({ navigation }: WelcomeScreenProps) {
  const insets = useSafeAreaInsets();
  const auth = useAuth();
  const markWelcomeSeen = usePreferences((s) => s.markWelcomeSeen);

  const [appleAvailable, setAppleAvailable] = useState(false);
  const [online, setOnline] = useState(networkMonitor.isOnline());
  const [busy, setBusy] = useState<'apple' | 'google' | 'continue' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const googleAvailable = isGoogleSignInConfigured();
  const signedIn = auth.status === 'signed_in';

  useEffect(() => {
    let alive = true;
    void isAppleSignInAvailable().then((ok) => alive && setAppleAvailable(ok));
    // Warm the city list now, so Continue rarely has to wait for it.
    void refreshCities();
    const unsubscribe = networkMonitor.subscribe(setOnline);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const proceed = async (): Promise<void> => {
    setBusy('continue');
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

  const signIn = async (provider: 'apple' | 'google'): Promise<void> => {
    setNotice(null);
    setBusy(provider);
    const outcome: SignInOutcome = provider === 'apple' ? await signInWithApple() : await signInWithGoogle();
    setBusy(null);
    if (outcome.kind === 'signed_in') {
      await proceed();
    } else if (outcome.kind === 'failed') {
      setNotice("Sign-in didn't work this time. You can try again, or continue without an account.");
    }
  };

  const disabled = busy !== null;
  const showSignIn = !signedIn && (appleAvailable || googleAvailable);

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
          <Text style={styles.signedIn} accessibilityRole="text">
            Signed in{auth.account?.displayName ? ` as ${auth.account.displayName}` : ''}
          </Text>
        ) : (
          showSignIn && (
            <View style={styles.providers} pointerEvents={disabled || !online ? 'none' : 'auto'}>
              {appleAvailable && (
                <AppleAuthentication.AppleAuthenticationButton
                  buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
                  buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
                  cornerRadius={14}
                  style={[styles.providerButton, (!online || disabled) && styles.dimmed]}
                  onPress={() => void signIn('apple')}
                />
              )}
              {googleAvailable && (
                <GoogleSigninButton
                  size={GoogleSigninButton.Size.Wide}
                  color={GoogleSigninButton.Color.Light}
                  style={[styles.providerButton, (!online || disabled) && styles.dimmed]}
                  onPress={() => void signIn('google')}
                />
              )}
              {!online && <Text style={styles.hint}>Signing in needs a connection.</Text>}
            </View>
          )
        )}

        {notice !== null && (
          <Text style={styles.notice} accessibilityRole="alert">
            {notice}
          </Text>
        )}

        <Pressable
          onPress={() => void proceed()}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityState={{ disabled, busy: busy === 'continue' }}
          style={({ pressed }) => [styles.cta, pressed && !disabled && styles.ctaPressed]}
        >
          {busy === 'continue' ? (
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
  providers: { gap: 10 },
  providerButton: { width: '100%', height: 50 },
  dimmed: { opacity: 0.4 },
  hint: { fontSize: 13, color: colors.inkMuted, textAlign: 'center' },
  signedIn: { fontSize: 15, fontWeight: '600', color: colors.accent, textAlign: 'center' },
  notice: { fontSize: 14, lineHeight: 20, color: colors.ink, textAlign: 'center' },
  cta: {
    minHeight: 54, borderRadius: 14, backgroundColor: colors.ink,
    alignItems: 'center', justifyContent: 'center', minWidth: MIN_TOUCH,
  },
  ctaPressed: { opacity: 0.85 },
  ctaText: { color: colors.canvas, fontSize: 17, fontWeight: '700' },
  fineprint: { fontSize: 13, color: colors.inkMuted, textAlign: 'center' },
});
