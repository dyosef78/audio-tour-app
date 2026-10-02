import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { openActiveTour } from './src/navigation/navigationRef';
import RootNavigator from './src/navigation/RootNavigator';
import { onTourNotificationTap } from './src/services/notifications/tourNotifications';
import { startAuth } from './src/services/auth/authStore';
// Imported for its module-scope side effect: registers the background location
// task with TaskManager before the OS can revive a cold JS context.
import { tourSession } from './src/session/TourSessionController';

export default function App() {
  useEffect(() => {
    // Resumes a tour a killed process was running (Epic 13 - replaces the old
    // "never resume" decision), or clears the tracking task it left behind.
    // Never rejects: failures are logged inside.
    void tourSession.reconcileOnColdStart();
  }, []);

  // Epic 15: a tap on "Tour paused" or "You've arrived" opens the tour screen,
  // where the Resume banner / the next-chapter button is waiting. The tap is
  // also what brings the app forward over Google Maps - the only sanctioned way.
  useEffect(() => onTourNotificationTap((data) => openActiveTour(data.tourId)), []);

  // Mirrors the stored session for the UI; never gates rendering (guest-first).
  useEffect(() => startAuth(), []);

  return (
    <SafeAreaProvider>
      <RootNavigator />
      <StatusBar style="auto" />
    </SafeAreaProvider>
  );
}
