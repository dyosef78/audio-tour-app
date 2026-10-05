/**
 * Epic 16 security - verify the JWT `amr` claim BEFORE migration 20261008120000
 * (is_cms_admin() requires an OTP sign-in) is pushed. PM constraint, 5 Oct
 * 2026: a false negative would lock every admin out of the CMS.
 *
 *   npm run auth:inspect-amr
 *
 * Signs in exactly as every admin CLI does (email code, adminSession.ts), then
 * prints - and only prints - what the database will see:
 *   amr (raw JSON), its shape and methods, aal, role, is_anonymous
 *   whether the migration's predicate would pass, on the fresh token
 *   the same after refreshSession(): a refreshed token must still carry otp,
 *   or a long CLI run would lose admin rights at its first refresh
 *
 * Never prints a token, a refresh token, a session id or the full address.
 * Read-only: changes nothing on the project.
 */

import { adminSessionFromEnv, maskEmail } from '../cms/adminSession.ts';
import { decodeJwtPayload, describeAmr, hasOtpAmr, type Claims } from '../cms/jwtClaims.ts';

function report(label: string, claims: Claims): boolean {
  const amr = describeAmr(claims);
  const pass = hasOtpAmr(claims);
  console.log(`\n${label}`);
  console.log(`  amr (raw)       ${JSON.stringify(amr.raw)}`);
  console.log(`  amr shape       ${amr.shape}`);
  console.log(`  amr methods     ${amr.methods.join(', ') || '(none)'}`);
  console.log(`  aal             ${String(claims['aal'])}`);
  console.log(`  role            ${String(claims['role'])}`);
  console.log(`  is_anonymous    ${String(claims['is_anonymous'])}`);
  console.log(`  predicate       ${pass ? 'PASS - is_cms_admin() would stay true' : 'FAIL - the migration would LOCK THIS ADMIN OUT'}`);
  return pass;
}

async function main(): Promise<void> {
  const { supabase, accessToken, email } = await adminSessionFromEnv();
  console.log(`Signed in as ${maskEmail(email)} (is_cms_admin() is true under the CURRENT definition).`);

  const fresh = report('Fresh token (straight after verifyOtp)', decodeJwtPayload(accessToken));

  const { data, error } = await supabase.auth.refreshSession();
  if (error || !data.session) throw new Error(`refreshSession failed: ${error?.message ?? 'no session'}`);
  const refreshed = report('After refreshSession()', decodeJwtPayload(data.session.access_token));

  console.log(`\nVERDICT: ${fresh && refreshed ? 'SAFE to push 20261008120000.' : 'DO NOT PUSH 20261008120000 - paste this output to the engineer.'}`);
  if (!(fresh && refreshed)) process.exitCode = 1;
  await supabase.auth.signOut({ scope: 'local' });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
