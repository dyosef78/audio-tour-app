import { GoogleSigninButton } from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  isAppleSignInAvailable,
  isGoogleSignInConfigured,
  signInWithApple,
  signInWithGoogle,
  type SignInOutcome,
} from '../../services/auth/AuthService';
import { networkMonitor } from '../../services/network/NetworkMonitor';
import { colors } from '../../ui/theme';

interface Props {
  /** Called after Supabase has accepted the sign-in. */
  onSignedIn: () => void;
  /** Lets the host disable its own actions while a provider sheet is up. */
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
}

/**
 * Apple and Google sign-in, as offered on Welcome and in Settings (TASK-1101,
 * shared since TASK-1104).
 *
 * The providers' own buttons, as their guidelines require. Renders nothing when
 * neither provider is available in this build, so a host never shows an empty
 * "sign in" section. Offline, the buttons dim and say why: sign-in is the one
 * thing in the app that needs a connection.
 */
export default function SignInButtons({ onSignedIn, onBusyChange, disabled = false }: Props) {
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [online, setOnline] = useState(networkMonitor.isOnline());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const googleAvailable = isGoogleSignInConfigured();

  useEffect(() => {
    let alive = true;
    void isAppleSignInAvailable().then((ok) => alive && setAppleAvailable(ok));
    const unsubscribe = networkMonitor.subscribe(setOnline);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const signIn = async (provider: 'apple' | 'google'): Promise<void> => {
    setNotice(null);
    setBusy(true);
    onBusyChange?.(true);
    const outcome: SignInOutcome = provider === 'apple' ? await signInWithApple() : await signInWithGoogle();
    setBusy(false);
    onBusyChange?.(false);
    if (outcome.kind === 'signed_in') {
      onSignedIn();
    } else if (outcome.kind === 'failed') {
      setNotice("Sign-in didn't work this time. You can try again, or carry on without an account.");
    }
  };

  if (!appleAvailable && !googleAvailable) return null;
  const inactive = busy || disabled || !online;

  return (
    <View style={styles.root}>
      <View style={styles.providers} pointerEvents={inactive ? 'none' : 'auto'}>
        {appleAvailable && (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
            cornerRadius={14}
            style={[styles.button, inactive && styles.dimmed]}
            onPress={() => void signIn('apple')}
          />
        )}
        {googleAvailable && (
          <GoogleSigninButton
            size={GoogleSigninButton.Size.Wide}
            color={GoogleSigninButton.Color.Light}
            style={[styles.button, inactive && styles.dimmed]}
            onPress={() => void signIn('google')}
          />
        )}
      </View>
      {!online && <Text style={styles.hint}>Signing in needs a connection.</Text>}
      {notice !== null && (
        <Text style={styles.notice} accessibilityRole="alert">
          {notice}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 10 },
  providers: { gap: 10 },
  button: { width: '100%', height: 50 },
  dimmed: { opacity: 0.4 },
  hint: { fontSize: 13, color: colors.inkSecondary, textAlign: 'center' },
  notice: { fontSize: 14, lineHeight: 20, color: colors.ink, textAlign: 'center' },
});
