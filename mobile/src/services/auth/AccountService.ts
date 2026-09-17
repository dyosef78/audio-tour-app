import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js';
import * as AppleAuthentication from 'expo-apple-authentication';
import { Platform } from 'react-native';

import { supabase } from '../supabase/client';
import { runAccountDeletion, type AppleReauthentication, type DeleteAccountOutcome, type InvokeResult } from './accountDeletion';
import { configureGoogle, isGoogleSignInConfigured } from './AuthService';
import { useAuth } from './authStore';

/**
 * Account deletion with the real platform calls (TASK-1104). The decisions are
 * in accountDeletion.ts; this only supplies Apple, Google and the function call.
 */

const DELETE_FUNCTION = 'delete-account';
/** Deleting a user and revoking with Apple is a few round trips; give it room. */
const DELETE_TIMEOUT_MS = 20_000;

async function reauthenticateWithApple(): Promise<AppleReauthentication> {
  if (Platform.OS !== 'ios') return 'unavailable';
  try {
    if (!(await AppleAuthentication.isAvailableAsync())) return 'unavailable';
    // No scopes: this is a confirmation, and Apple would not resend the name anyway.
    const credential = await AppleAuthentication.signInAsync({ requestedScopes: [] });
    return credential.authorizationCode ? { authorizationCode: credential.authorizationCode } : 'unavailable';
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
    // Backing out of the Apple sheet backs out of deleting.
    return code === 'ERR_REQUEST_CANCELED' ? 'cancelled' : 'unavailable';
  }
}

async function invokeDelete(body: Record<string, unknown>): Promise<InvokeResult> {
  try {
    const { data, error } = await supabase.functions.invoke(DELETE_FUNCTION, { body, timeout: DELETE_TIMEOUT_MS });
    if (!error) return { status: 200, data };
    if (error instanceof FunctionsHttpError) {
      const status = (error.context as { status?: number } | undefined)?.status ?? 500;
      return { status, data: null };
    }
    if (error instanceof FunctionsFetchError) return { networkError: error.message };
    // FunctionsRelayError: the platform, not our function. Not "offline".
    return { status: 502, data: null };
  } catch (err) {
    return { networkError: err instanceof Error ? err.message : String(err) };
  }
}

export function deleteAccount(): Promise<DeleteAccountOutcome> {
  return runAccountDeletion({
    provider: useAuth.getState().account?.provider ?? null,
    reauthenticateWithApple,
    invokeDelete,
    // `local`: the server session died with the user. supabase-js removes the
    // stored session even though the revoke call is now refused.
    signOutLocally: async () => {
      await supabase.auth.signOut({ scope: 'local' });
    },
    revokeGoogleAccess: async () => {
      if (!isGoogleSignInConfigured()) return;
      configureGoogle();
      // Ends this app's grant with Google, not just the local Google session.
      await GoogleSignin.revokeAccess();
    },
  });
}
