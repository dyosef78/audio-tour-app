import {
  GoogleSignin,
  isCancelledResponse,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';
import { Platform } from 'react-native';

import { supabase } from '../supabase/client';

/**
 * Optional sign-in with Apple or Google (TASK-1102). The buttons are TASK-1101.
 *
 * Both are native flows that hand Supabase an ID token (signInWithIdToken): no
 * browser redirect, no deep link, no PKCE verifier to store. Nothing here ever
 * blocks the app - the caller always has "Continue without account".
 *
 * Apple is iOS only (expo-apple-authentication has no Android implementation),
 * and App Store guideline 4.8 is why it is offered wherever Google is.
 *
 * Google needs OAuth clients this repo cannot mint: EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID
 * (the token audience Supabase verifies) everywhere, plus
 * EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID on iOS, from which app.config.ts derives the
 * URL scheme. Until both exist isGoogleSignInConfigured() is false and the UI
 * must not show the button.
 */

export type SignInOutcome =
  | { kind: 'signed_in' }
  /** The user backed out. Not an error; show nothing. */
  | { kind: 'cancelled' }
  /** For logs and a generic message - never shown verbatim. */
  | { kind: 'failed'; reason: string };

const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '';
const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '';

function failed(provider: string, err: unknown): SignInOutcome {
  const reason = `${provider}: ${err instanceof Error ? err.message : String(err)}`;
  console.warn('[Auth] sign-in failed -', reason);
  return { kind: 'failed', reason };
}

function codeOf(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

/** Hands a provider's ID token to Supabase. Network failures resolve into `error`, but a throw is caught too. */
async function exchange(provider: 'apple' | 'google', token: string): Promise<SignInOutcome> {
  try {
    const { error } = await supabase.auth.signInWithIdToken({ provider, token });
    return error ? failed(provider, error) : { kind: 'signed_in' };
  } catch (err) {
    return failed(provider, err);
  }
}

// -----------------------------------------------------------------------------
// Apple
// -----------------------------------------------------------------------------

export async function isAppleSignInAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

export async function signInWithApple(): Promise<SignInOutcome> {
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
  } catch (err) {
    if (codeOf(err) === 'ERR_REQUEST_CANCELED') return { kind: 'cancelled' };
    return failed('apple', err);
  }

  if (!credential.identityToken) return failed('apple', 'no identity token in the credential');

  const outcome = await exchange('apple', credential.identityToken);
  if (outcome.kind !== 'signed_in') return outcome;

  // Apple sends the name on the FIRST authorisation only, ever; the ID token
  // never carries it. Saved now or not at all. Best-effort: a failure here
  // costs a display name, not the sign-in.
  const name = credential.fullName;
  const fullName = name ? AppleAuthentication.formatFullName(name).trim() : '';
  if (name && fullName !== '') {
    const { error } = await supabase.auth.updateUser({
      data: { full_name: fullName, given_name: name.givenName, family_name: name.familyName },
    });
    if (error) console.warn('[Auth] could not save the name Apple provided:', error.message);
  }

  return outcome;
}

// -----------------------------------------------------------------------------
// Google
// -----------------------------------------------------------------------------

export function isGoogleSignInConfigured(): boolean {
  if (GOOGLE_WEB_CLIENT_ID === '') return false;
  // The same test app.config.ts applies before it registers the URL scheme; a
  // looser one here would show a button whose native flow crashes on iOS.
  return Platform.OS !== 'ios' || GOOGLE_IOS_CLIENT_ID.endsWith('.apps.googleusercontent.com');
}

let googleConfigured = false;

/** Idempotent. Every GoogleSignin call needs it in this process, including revokeAccess (TASK-1104). */
export function configureGoogle(): void {
  if (googleConfigured) return;
  GoogleSignin.configure({
    webClientId: GOOGLE_WEB_CLIENT_ID,
    ...(Platform.OS === 'ios' ? { iosClientId: GOOGLE_IOS_CLIENT_ID } : {}),
  });
  googleConfigured = true;
}

export async function signInWithGoogle(): Promise<SignInOutcome> {
  if (!isGoogleSignInConfigured()) return failed('google', 'not configured in this build');

  try {
    configureGoogle();
    if (Platform.OS === 'android') {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    }
    const response = await GoogleSignin.signIn();
    if (isCancelledResponse(response)) return { kind: 'cancelled' };
    if (!isSuccessResponse(response) || !response.data.idToken) {
      return failed('google', 'no ID token (is the web client ID the one registered in Supabase?)');
    }
    return await exchange('google', response.data.idToken);
  } catch (err) {
    if (isErrorWithCode(err) && err.code === statusCodes.SIGN_IN_CANCELLED) return { kind: 'cancelled' };
    return failed('google', err);
  }
}

// -----------------------------------------------------------------------------
// Sign-out
// -----------------------------------------------------------------------------

/**
 * Signs out THIS device and returns the app to guest.
 *
 * `local`, not the default `global`: signing out on a phone should not end the
 * user's other sessions. Works offline - supabase-js 2.112 removes the stored
 * session even when the revoke request fails - but the refresh token is then
 * only forgotten, not revoked, until it expires server-side.
 */
export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) console.warn('[Auth] sign-out could not reach the server; signed out locally:', error.message);

  if (isGoogleSignInConfigured()) {
    try {
      configureGoogle();
      // So the next Google sign-in offers the account chooser again.
      await GoogleSignin.signOut();
    } catch {
      // Cosmetic only.
    }
  }
}
