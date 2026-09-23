import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Dynamic Expo config (TASK-102).
 *
 * Exists solely so the Google Maps Android key can come from the environment
 * instead of being committed. Everything static stays in app.json, which this
 * spreads via `config`.
 *
 * The variable is deliberately NOT named EXPO_PUBLIC_*. That prefix inlines a
 * value into the JS bundle, which is correct for the Supabase anon key and
 * wrong here: this key is consumed at build time by the config plugin, which
 * writes it into AndroidManifest.xml as `com.google.android.geo.API_KEY`. It
 * never needs to exist in JavaScript.
 *
 * Worth stating plainly, because it changes what "secret" means: that manifest
 * entry ships inside every APK and can be read by anyone who unzips one. Keeping
 * it out of git prevents automated scraping of the public repo, which is real
 * and worth doing - but the control that actually prevents abuse is restricting
 * the key in Google Cloud Console to our package name plus signing certificate
 * SHA-1. That is still outstanding; see the handover report.
 */
const GOOGLE_CLIENT_ID_SUFFIX = '.apps.googleusercontent.com';

/**
 * Epic 12 (PM directive): an EAS build without Google Sign-In configuration
 * must FAIL, loudly, instead of shipping an app whose Google button is silently
 * hidden - which is what every build did until Epic 12, because no EAS profile
 * set these variables.
 *
 * Only on EAS build workers (EAS_BUILD=true, set by EAS itself). This config is
 * also evaluated by `expo start`, `expo config`, prebuild and CI, which have no
 * reason to hold the IDs; they keep the old behaviour (button hidden, warning).
 *
 * It checks what the build can see. It cannot check what lives in Google Cloud
 * or the Supabase dashboard - the Android OAuth client's SHA-1s, or the client
 * IDs in Supabase's "Authorized Client IDs" - so a green build does not prove
 * sign-in works on a device.
 */
export function googleSignInConfigErrors(env: Record<string, string | undefined>): string[] {
  const errors: string[] = [];
  for (const name of ['EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID', 'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID']) {
    const value = env[name]?.trim() ?? '';
    if (value === '') errors.push(`${name} is not set`);
    else if (!value.endsWith(GOOGLE_CLIENT_ID_SUFFIX)) errors.push(`${name} does not end in ${GOOGLE_CLIENT_ID_SUFFIX}`);
  }
  return errors;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  if (process.env.EAS_BUILD === 'true') {
    const errors = googleSignInConfigErrors(process.env);
    if (errors.length > 0) {
      throw new Error(
        '\n[app.config] EAS build refused: Google Sign-In is not configured.\n' +
          errors.map((e) => `  - ${e}\n`).join('') +
          "  Set both as EAS environment variables for this build profile's environment\n" +
          '  (plain text or sensitive, not secret: EXPO_PUBLIC_ values are compiled into the app).\n' +
          `  Profile: ${process.env.EAS_BUILD_PROFILE ?? 'unknown'}, platform: ${process.env.EAS_BUILD_PLATFORM ?? 'unknown'}.\n`,
      );
    }
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    // Warn rather than throw: this config is evaluated by `expo start`,
    // `expo config` and prebuild alike, and an iOS-only or Expo Go developer
    // has no need of the key. Throwing would block them for nothing.
    console.warn(
      '\n[app.config] GOOGLE_MAPS_API_KEY is not set.\n' +
        '  Android builds will render a blank map. Add it to mobile/.env\n' +
        '  (gitignored) or supply it as an EAS environment variable.\n' +
        '  iOS is unaffected - it uses Apple Maps, which needs no key.\n',
    );
  }

  // TASK-1102. Google Sign-In's config plugin, given no options, assumes Firebase
  // and fails prebuild without GoogleService-Info.plist - so it is added only
  // with a client ID. The URL scheme is DERIVED from the same variable the JS
  // configures GoogleSignin with (AuthService.ts), so the two cannot disagree:
  // "123-abc.apps.googleusercontent.com" -> "com.googleusercontent.apps.123-abc".
  // A public client ID, correctly EXPO_PUBLIC_.
  const googleIosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim() ?? '';
  const googlePlugins: NonNullable<ExpoConfig['plugins']> = [];
  if (googleIosClientId.endsWith(GOOGLE_CLIENT_ID_SUFFIX)) {
    const iosUrlScheme = `com.googleusercontent.apps.${googleIosClientId.slice(0, -GOOGLE_CLIENT_ID_SUFFIX.length)}`;
    googlePlugins.push(['@react-native-google-signin/google-signin', { iosUrlScheme }]);
  }
  const googleErrors = googleSignInConfigErrors(process.env);
  if (googleErrors.length > 0) {
    // Not an EAS build (that threw above): local development and CI.
    console.warn(`\n[app.config] Google Sign-In is off in this build: ${googleErrors.join('; ')}.\n`);
  }

  return {
    ...config,
    plugins: [...(config.plugins ?? []), ...googlePlugins],
    name: config.name ?? 'Audio Tour',
    slug: config.slug ?? 'audio-tour-app',
    android: {
      ...config.android,
      // Omitted entirely when absent. The react-native-maps plugin removes the
      // manifest meta-data for a falsy key, so a keyless build is clean rather
      // than carrying a bogus placeholder into the manifest.
      ...(apiKey ? { config: { googleMaps: { apiKey } } } : {}),
    },
  };
};
