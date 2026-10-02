import { Linking, Platform } from 'react-native';

/**
 * The native half of the navigation handoff (Epic 15, Slice 5); the decisions
 * are in handoff/handoffLinks.ts.
 *
 * "Is Google Maps installed?" asks for a scheme only the app handles:
 * comgooglemaps:// on iOS, a google.navigation: intent on Android. Both are
 * declared in app.config.ts (LSApplicationQueriesSchemes / <queries>) - an
 * undeclared scheme always answers false.
 */
const GOOGLE_MAPS_PROBE = Platform.OS === 'ios' ? 'comgooglemaps://' : 'google.navigation:q=0,0';

export async function isGoogleMapsInstalled(): Promise<boolean> {
  return Linking.canOpenURL(GOOGLE_MAPS_PROBE);
}

/** Hand off. Throws if the OS refuses - the caller tells the listener. */
export async function openNavigationUrl(url: string): Promise<void> {
  await Linking.openURL(url);
}
