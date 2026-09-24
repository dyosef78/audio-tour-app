/**
 * Epic 13 - the only form of a user id that may leave Supabase in a log line.
 *
 * logger.ts calls this for every event carrying `user_id` and ships `user_ref`
 * instead, to Axiom and to the console alike. A user id in a third party's
 * dataset would outlive the account it names: deletion removes the auth row,
 * not the log history.
 *
 * WHY A KEYED HASH (HMAC-SHA-256), NOT A PLAIN SHA-256. Anyone holding user ids
 * from elsewhere - a database export, a support ticket, another log - could
 * hash them and join them to our lines. With a secret key they cannot; only
 * someone holding LOG_PSEUDONYM_KEY can turn an id into its ref. (Same reasoning
 * as the rate limiter's IP buckets, route-stops/rateLimit.ts.)
 *
 * A dedicated key rather than the service role key: support needs the key to
 * look a user up, and must not need the service role to do it. Rotating it
 * makes older refs unmatchable, which is the intended way to retire them.
 *
 * Support lookup, for a user id taken from a ticket:
 *   node -e "console.log(require('crypto').createHmac('sha256', process.env.LOG_PSEUDONYM_KEY).update('user:' + process.argv[1]).digest('hex'))" <user-id>
 */

export type UserRefFn = (userId: string) => Promise<string>;

/** Shorter keys are refused: this key is the only thing between a ref and an id. */
export const MIN_KEY_LENGTH = 32;

export function createUserRef(secret: string): UserRefFn {
  if (secret.length < MIN_KEY_LENGTH) throw new Error(`LOG_PSEUDONYM_KEY must be at least ${MIN_KEY_LENGTH} characters`);
  const key = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return async (userId) => {
    // Domain-separated, so a future ref of another kind (a device, a tour) can
    // never collide with a user's.
    const mac = await crypto.subtle.sign('HMAC', await key, new TextEncoder().encode(`user:${userId}`));
    return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
  };
}

/** The ref function from the environment, or why there is none. */
export function userRefFromEnv(env: Record<string, string | undefined>): { userRef: UserRefFn } | { userRef: null; reason: string } {
  const secret = env.LOG_PSEUDONYM_KEY ?? '';
  if (secret === '') return { userRef: null, reason: 'LOG_PSEUDONYM_KEY not set' };
  if (secret.length < MIN_KEY_LENGTH) return { userRef: null, reason: `LOG_PSEUDONYM_KEY shorter than ${MIN_KEY_LENGTH} characters` };
  return { userRef: createUserRef(secret) };
}
