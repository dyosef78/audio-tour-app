import AsyncStorage from '@react-native-async-storage/async-storage';
import { AESEncryptionKey, AESKeySize, AESSealedData, aesDecryptAsync, aesEncryptAsync } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { utf8Decode, utf8Encode } from './utf8';

/**
 * Encrypted storage for the Supabase auth session (TASK-1102).
 *
 * The session holds a long-lived refresh token, so it does not belong in plain
 * AsyncStorage, where it sat before this task. It cannot go straight into
 * SecureStore either: some iOS releases refuse values over ~2048 bytes, and a
 * session carrying an Apple or Google identity is well past that. So, as
 * Supabase's own Expo guide does, a per-item AES-256 key lives in the
 * Keychain / Android Keystore and the ciphertext lives in AsyncStorage. Unlike
 * that guide this uses expo-crypto's native AES-GCM (new in SDK 57): the tag
 * authenticates the ciphertext, and the storage key is bound in as additional
 * data so a blob cannot be replayed under another key.
 *
 * KEYCHAIN ACCESSIBILITY - AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY, not the default
 * WHEN_UNLOCKED. A tour runs with the phone locked in a pocket: the background
 * location task, the telemetry flush and route-stops all reach this client
 * then. Under WHEN_UNLOCKED the key read fails and a signed-in walker silently
 * becomes anonymous mid-tour. THIS_DEVICE_ONLY keeps the key out of backups, so
 * a refresh token restored onto another phone is unreadable there.
 *
 * FAILURE POLICY. The distinction that matters is transient vs permanent:
 *   - The keychain read THROWS (device still locked since boot, Keystore busy):
 *     rethrown. supabase-js then reports no session WITHOUT deleting it, and
 *     authStore asks again when the app next comes to the foreground.
 *   - The ciphertext has no key, or will not decrypt: permanent. The usual
 *     cause is a restore - Android Auto Backup carries AsyncStorage but the
 *     SecureStore plugin excludes its own data, and THIS_DEVICE_ONLY does the
 *     same on iOS. Both halves are discarded and the user is signed out, which
 *     for a guest-first app costs one tap. Never a crash, never a loop.
 */

const CIPHERTEXT_PREFIX = 'secure-session:';
/** Bumped if the envelope changes; an unknown version is discarded, not guessed at. */
const ENVELOPE = 'v1:';

const KEYCHAIN_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/** SecureStore keys allow only [A-Za-z0-9._-]; supabase-js's keys already fit, others are made to. */
export function keychainKeyFor(storageKey: string): string {
  return `session-key.${storageKey.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

export function ciphertextKeyFor(storageKey: string): string {
  return CIPHERTEXT_PREFIX + storageKey;
}

/** The subset of supabase-js's SupportedStorage this implements. */
export class SecureSessionStorage {
  /** Imported keys, so a token refresh does not cost a Keychain round trip. */
  private readonly keys = new Map<string, AESEncryptionKey>();
  /** One creation per storage key, so two first writes cannot mint two keys. */
  private readonly creating = new Map<string, Promise<AESEncryptionKey>>();

  async getItem(storageKey: string): Promise<string | null> {
    const envelope = await AsyncStorage.getItem(ciphertextKeyFor(storageKey));
    if (envelope === null) return null;

    if (!envelope.startsWith(ENVELOPE)) {
      await this.discard(storageKey, 'unrecognised envelope');
      return null;
    }

    // Deliberately outside the try: a keychain that cannot be read right now is
    // transient and must not cost the user their session. See the header.
    const encodedKey = this.keys.has(storageKey)
      ? null
      : await SecureStore.getItemAsync(keychainKeyFor(storageKey), KEYCHAIN_OPTIONS);

    try {
      let key = this.keys.get(storageKey);
      if (key === undefined) {
        if (encodedKey === null) {
          await this.discard(storageKey, 'no key for stored session (restored from a backup?)');
          return null;
        }
        key = await AESEncryptionKey.import(encodedKey, 'base64');
        this.keys.set(storageKey, key);
      }

      const sealed = AESSealedData.fromCombined(envelope.slice(ENVELOPE.length));
      const plaintext = await aesDecryptAsync(sealed, key, {
        output: 'bytes',
        additionalData: utf8Encode(storageKey),
      });
      return utf8Decode(plaintext);
    } catch {
      // A wrong key, a corrupt blob, a blob moved between keys: all fail the tag.
      await this.discard(storageKey, 'stored session could not be decrypted');
      return null;
    }
  }

  async setItem(storageKey: string, value: string): Promise<void> {
    const key = await this.keyForWrite(storageKey);
    const sealed = await aesEncryptAsync(utf8Encode(value), key, { additionalData: utf8Encode(storageKey) });
    const combined = await sealed.combined('base64');
    await AsyncStorage.setItem(ciphertextKeyFor(storageKey), ENVELOPE + combined);
  }

  async removeItem(storageKey: string): Promise<void> {
    // Ciphertext first: if deleting the key then fails, what is left is a key
    // with nothing to decrypt, which is harmless. The reverse would strand a
    // session that can never be read.
    await AsyncStorage.removeItem(ciphertextKeyFor(storageKey));
    this.keys.delete(storageKey);
    await SecureStore.deleteItemAsync(keychainKeyFor(storageKey), KEYCHAIN_OPTIONS);
  }

  private keyForWrite(storageKey: string): Promise<AESEncryptionKey> {
    const cached = this.keys.get(storageKey);
    if (cached !== undefined) return Promise.resolve(cached);

    let pending = this.creating.get(storageKey);
    if (pending === undefined) {
      pending = (async () => {
        const name = keychainKeyFor(storageKey);
        const existing = await SecureStore.getItemAsync(name, KEYCHAIN_OPTIONS);
        let key: AESEncryptionKey | null = null;
        if (existing !== null) {
          try {
            key = await AESEncryptionKey.import(existing, 'base64');
          } catch {
            key = null; // Unimportable - replaced below, and the write re-encrypts under the new one.
          }
        }
        if (key === null) {
          key = await AESEncryptionKey.generate(AESKeySize.AES256);
          // Persisted BEFORE it is used, so no ciphertext is ever written under
          // a key that exists only in memory.
          await SecureStore.setItemAsync(name, await key.encoded('base64'), KEYCHAIN_OPTIONS);
        }
        this.keys.set(storageKey, key);
        return key;
      })().finally(() => this.creating.delete(storageKey));
      this.creating.set(storageKey, pending);
    }
    return pending;
  }

  private async discard(storageKey: string, reason: string): Promise<void> {
    // The reason only - never the envelope or the key.
    console.warn(`[Auth] discarding stored session: ${reason}`);
    try {
      await this.removeItem(storageKey);
    } catch (err) {
      console.warn('[Auth] could not clear the unreadable session:', err);
    }
  }
}

export const secureSessionStorage = new SecureSessionStorage();
