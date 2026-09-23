/**
 * In-memory expo-secure-store for the Node harness (TASK-1102).
 *
 * Records the options of every call, so a test can prove the keychain
 * accessibility the background location task depends on, and can make reads
 * throw the way a Keychain does before the first unlock after a reboot.
 */

export type KeychainAccessibilityConstant = number;

export const WHEN_UNLOCKED: KeychainAccessibilityConstant = 5;
export const AFTER_FIRST_UNLOCK: KeychainAccessibilityConstant = 0;
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: KeychainAccessibilityConstant = 1;

export interface SecureStoreOptions {
  keychainAccessible?: KeychainAccessibilityConstant;
}

const store = new Map<string, string>();
export const __calls: { op: string; key: string; options: SecureStoreOptions | undefined }[] = [];

let failReads = false;
export function __setFailReads(fail: boolean): void {
  failReads = fail;
}

export function __reset(): void {
  store.clear();
  __calls.length = 0;
  failReads = false;
}

export function __dump(): Record<string, string> {
  return Object.fromEntries(store);
}

function checkKey(key: string): void {
  // The real module rejects these; a stub that accepted them would hide a bug.
  if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error(`Invalid SecureStore key: ${key}`);
}

export async function getItemAsync(key: string, options?: SecureStoreOptions): Promise<string | null> {
  __calls.push({ op: 'get', key, options });
  checkKey(key);
  if (failReads) throw new Error('User interaction is not allowed. (simulated locked keychain)');
  return store.get(key) ?? null;
}

export async function setItemAsync(key: string, value: string, options?: SecureStoreOptions): Promise<void> {
  __calls.push({ op: 'set', key, options });
  checkKey(key);
  store.set(key, value);
}

export async function deleteItemAsync(key: string, options?: SecureStoreOptions): Promise<void> {
  __calls.push({ op: 'delete', key, options });
  checkKey(key);
  store.delete(key);
}
