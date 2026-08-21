import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import RootNavigator from './src/navigation/RootNavigator';
// Imported for its module-scope side effect: registers the background location
// task with TaskManager before the OS can revive a cold JS context.
import { tourSession } from './src/session/TourSessionController';

export default function App() {
  useEffect(() => {
    // Clears any background location task a force-killed process left running.
    // Per the PM decision this never resumes a tour - stop and clear, silently.
    void tourSession.reconcileOnColdStart();
  }, []);

  return (
    <SafeAreaProvider>
      <RootNavigator />
      <StatusBar style="auto" />
    </SafeAreaProvider>
  );
}
