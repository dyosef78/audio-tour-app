/**
 * Reading a Supabase access token's claims WITHOUT verifying it - for the
 * operator's own token, to show what the database will see. Never use this to
 * make an authorisation decision: the database verifies; this only reports.
 *
 * The amr (authentication methods references) claim is what migration
 * 20261008120000 makes is_cms_admin() require. Supabase Auth writes it as an
 * array of OBJECTS, e.g. [{"method":"otp","timestamp":1759650000}] - not the
 * RFC 8176 array of strings. hasOtpAmr() mirrors the SQL predicate exactly
 * (jsonb_path_exists(claims, '$.amr[*] ? (@.method == "otp")')), so the
 * inspection script can say in advance whether the migration would lock the
 * admin out.
 */

export type Claims = Record<string, unknown>;

export function decodeJwtPayload(token: string): Claims {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) throw new Error('not a JWT (expected three dot-separated parts)');
  const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const payload: unknown = JSON.parse(json);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('JWT payload is not an object');
  return payload as Claims;
}

/** The amr claim exactly as sent, and its shape - the thing a false negative would hide in. */
export function describeAmr(claims: Claims): { raw: unknown; shape: 'array_of_objects' | 'array_of_strings' | 'mixed_array' | 'absent' | 'other'; methods: string[] } {
  const raw = claims['amr'];
  if (raw === undefined) return { raw, shape: 'absent', methods: [] };
  if (!Array.isArray(raw)) return { raw, shape: 'other', methods: [] };
  const objects = raw.filter((e) => typeof e === 'object' && e !== null && !Array.isArray(e)) as Record<string, unknown>[];
  const strings = raw.filter((e): e is string => typeof e === 'string');
  const shape = raw.length > 0 && objects.length === raw.length ? 'array_of_objects' : raw.length > 0 && strings.length === raw.length ? 'array_of_strings' : raw.length === 0 ? 'array_of_objects' : 'mixed_array';
  const methods = [...objects.map((o) => (typeof o['method'] === 'string' ? (o['method'] as string) : '?')), ...strings];
  return { raw, shape, methods };
}

/** The SQL predicate's twin: some amr element is an object whose method is "otp". */
export function hasOtpAmr(claims: Claims): boolean {
  const raw = claims['amr'];
  return Array.isArray(raw) && raw.some((e) => typeof e === 'object' && e !== null && !Array.isArray(e) && (e as Record<string, unknown>)['method'] === 'otp');
}
