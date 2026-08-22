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
export default ({ config }: ConfigContext): ExpoConfig => {
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

  return {
    ...config,
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
