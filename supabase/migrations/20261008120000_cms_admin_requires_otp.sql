-- =============================================================================
-- Epic 16 security: is_cms_admin() requires an EMAIL-CODE (OTP) sign-in
--
-- STATUS: approved by the PM 5 Oct 2026. VERIFIED before applying: the PM ran
-- `npm run auth:inspect-amr` against production and it printed SAFE - the
-- live token's amr is [{"method":"otp","timestamp":...}], before and after a
-- refresh (PM constraint: a false negative here would lock every admin out).
--
-- WHY. Admin CLIs sign in by email code only (PM, 4 Oct 2026: no static
-- passwords for production admin access). But the Email provider that sends
-- those codes also accepts passwords: a signed-in admin can call
-- auth.updateUser({ password }) and from then on sign in with a static
-- password - the exact path the PM ruled out. Deleting the Reset Password
-- email template does not close it (updateUser needs no email). This does:
-- however a session was obtained, it carries admin rights only if its token
-- says it was obtained with a one-time code.
--
-- THE CLAIM. Supabase Auth writes `amr` as an array of OBJECTS:
--   "amr": [{"method": "otp", "timestamp": 1759650000}]
-- not RFC 8176's array of strings. The predicate is a jsonpath in LAX mode,
-- so a missing amr or string elements evaluate to FALSE - never to an error
-- that would break every admin policy at once. Lax mode would also wrap a
-- bare OBJECT amr as a one-element array and accept it; the jsonb_typeof test
-- refuses that, so this predicate and backend/cms/jwtClaims.ts hasOtpAmr()
-- (which auth:inspect-amr uses to predict it) agree on every shape.
--
-- WHAT CHANGES FOR WHOM.
--   Admin CLIs (email code)                 unchanged: amr carries "otp"
--   An admin signed in with a password      no admin rights (the point)
--   An admin signed in with Apple / Google  no admin rights - including in the
--     ("oauth") on the phone app            mobile app (draft tours, telemetry
--                                           reads). Admin work is CLI-only.
--   Everyone else                           unchanged (never admins)
--
-- Every admin policy calls is_cms_admin(), so this one definition moves them
-- all: tours/waypoints/audio_tracks/chapters/cities writes, the audio bucket,
-- telemetry reads, assert_cms_admin() (every cms_* RPC), and the warm-costs
-- Edge Function's caller check. Signature, volatility, SECURITY DEFINER,
-- search_path and grants are unchanged (CREATE OR REPLACE keeps the grants
-- set by 20261002120000).
--
-- WHAT THIS DOES TO EXISTING DATA: nothing. Live admin sessions obtained by
-- code keep working; any obtained otherwise lose admin rights immediately
-- (checked per statement, not at token expiry).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.is_cms_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
    SELECT
        coalesce(auth.jwt() ->> 'is_anonymous', 'false') <> 'true'
        AND jsonb_typeof(auth.jwt() -> 'amr') = 'array'
        AND jsonb_path_exists(auth.jwt(), '$.amr[*] ? (@.method == "otp")')
        AND EXISTS (
            SELECT 1 FROM public.app_admins a WHERE a.user_id = auth.uid()
        );
$fn$;

COMMENT ON FUNCTION public.is_cms_admin() IS
    'True when the calling user is a CMS administrator AND this session was obtained with an email one-time code (JWT amr contains method "otp"; migration 20261008120000). Takes no argument and reports only on the caller, so it is not an enumeration oracle. Checked live against app_admins, so revoking admin takes effect immediately rather than at token expiry.';
