/**
 * Epic 16 Part 5 - admin CLI sign-in by email code (`npm run test:admin-auth`).
 * A fake auth client and a scripted terminal; no network, no email.
 */

import { AdminSignInError, maskEmail, MAX_CODE_ATTEMPTS, signInAdminWithOtp, type OtpAuthClient, type OtpIo } from '../cms/adminSession.ts';
import { decodeJwtPayload, describeAmr, hasOtpAmr } from '../cms/jwtClaims.ts';

let checks = 0;
let failures = 0;
function assert(label: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? ` - ${detail}` : ''}`);
}

interface Fake {
  client: OtpAuthClient;
  sends: { email: string; shouldCreateUser: boolean }[];
  verifies: string[];
}

function fake(o: { sendError?: string; goodCode?: string; isAdmin?: boolean } = {}): Fake {
  const f: Fake = { sends: [], verifies: [], client: undefined as unknown as OtpAuthClient };
  f.client = {
    auth: {
      signInWithOtp: async ({ email, options }) => {
        f.sends.push({ email, shouldCreateUser: options.shouldCreateUser });
        return { error: o.sendError ? { message: o.sendError } : null };
      },
      verifyOtp: async ({ token }) => {
        f.verifies.push(token);
        return token === (o.goodCode ?? '123456')
          ? { data: { session: { access_token: 'ACCESS' } }, error: null }
          : { data: { session: null }, error: { message: 'Token has expired or is invalid' } };
      },
    },
    rpc: async () => ({ data: o.isAdmin ?? true, error: null }),
  };
  return f;
}

function io(answers: string[], interactive = true): OtpIo & { said: string[] } {
  const said: string[] = [];
  return { interactive, said, ask: async () => answers.shift() ?? '', say: (l) => { said.push(l); } };
}

async function rejects(label: string, p: Promise<unknown>, re: RegExp): Promise<void> {
  try { await p; assert(label, false, 'resolved'); } catch (e) { assert(label, e instanceof AdminSignInError && re.test(e.message), String(e)); }
}

const EMAIL = 'admin@example.com';

{
  const f = fake();
  const r = await signInAdminWithOtp(f.client, EMAIL, io(['123456']));
  assert('a good code -> the access token', r.accessToken === 'ACCESS');
  assert('one code is sent, and never creates an account', f.sends.length === 1 && f.sends[0]!.shouldCreateUser === false);
}
{
  const f = fake();
  const t = io(['12ab', '000000', '123456']);
  const r = await signInAdminWithOtp(f.client, EMAIL, t);
  assert('a typo and a wrong code can be retried without a second email', r.accessToken === 'ACCESS' && f.sends.length === 1 && f.verifies.length === 2);
  assert('a non-code is not even sent to Supabase', !f.verifies.includes('12ab'));
}
{
  const f = fake();
  await rejects(`${MAX_CODE_ATTEMPTS} wrong codes -> stop`, signInAdminWithOtp(f.client, EMAIL, io(['111111', '222222', '333333'])), /No valid code/);
  assert('...after exactly one email', f.sends.length === 1);
}
{
  const f = fake();
  await rejects('no terminal -> refused before any email is sent', signInAdminWithOtp(f.client, EMAIL, io(['123456'], false)), /interactive terminal/);
  assert('...so nothing was sent', f.sends.length === 0);
}
await rejects('provider disabled -> says what to enable', signInAdminWithOtp(fake({ sendError: 'Email logins are disabled' }).client, EMAIL, io([])), /Enable the Email provider/);
await rejects('unknown address -> says sign-up is closed', signInAdminWithOtp(fake({ sendError: 'Signups not allowed for otp' }).client, EMAIL, io([])), /sign-up is closed/);
await rejects('Supabase cool-down -> says it is rate limiting', signInAdminWithOtp(fake({ sendError: 'For security purposes, you can only request this after 47 seconds.' }).client, EMAIL, io([])), /rate-limiting/);
await rejects('signed in but not an admin -> stop', signInAdminWithOtp(fake({ isAdmin: false }).client, EMAIL, io(['123456'])), /not a CMS admin/);
{
  const t = io(['123456']);
  await signInAdminWithOtp(fake().client, EMAIL, t);
  assert('the address is masked on screen', t.said.some((l) => l.includes('a****@example.com')) && !t.said.some((l) => l.includes(EMAIL)), JSON.stringify(t.said));
}
assert('maskEmail keeps the domain, hides the user', maskEmail('dana@x.io') === 'd***@x.io' && maskEmail('nope') === '***');


// jwtClaims - what auth:inspect-amr reports, and the twin of 20261008120000's predicate.
{
  const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = (claims: unknown) => `${b64url({ alg: 'HS256' })}.${b64url(claims)}.sig`;
  const otp = { amr: [{ method: 'otp', timestamp: 1759650000 }], aal: 'aal1', role: 'authenticated' };
  const decoded = decodeJwtPayload(jwt(otp));
  assert('a token payload decodes (base64url)', JSON.stringify(decoded.amr) === JSON.stringify(otp.amr));
  assert('Supabase shape (objects with method "otp") passes', hasOtpAmr(decoded) && describeAmr(decoded).shape === 'array_of_objects');
  assert('password sign-in fails', !hasOtpAmr({ amr: [{ method: 'password', timestamp: 1 }] }));
  assert('Apple/Google (oauth) fails', !hasOtpAmr({ amr: [{ method: 'oauth', timestamp: 1 }] }));
  assert('otp among several methods passes', hasOtpAmr({ amr: [{ method: 'password', timestamp: 1 }, { method: 'otp', timestamp: 2 }] }));
  assert('RFC 8176 strings ["otp"] FAIL - the lockout shape the inspection exists to catch', !hasOtpAmr({ amr: ['otp'] }) && describeAmr({ amr: ['otp'] }).shape === 'array_of_strings');
  assert('no amr fails, and is reported as absent', !hasOtpAmr({}) && describeAmr({}).shape === 'absent');
  assert('a non-array amr fails without throwing', !hasOtpAmr({ amr: { method: 'otp' } }) && describeAmr({ amr: 'otp' }).shape === 'other');
  let threw = false;
  try { decodeJwtPayload('not-a-token'); } catch { threw = true; }
  assert('a non-JWT is refused loudly', threw);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
