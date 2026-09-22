import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useCallback, useEffect, useState } from 'react';

import AudioPlayerSheet from '../components/AudioPlayerSheet';
import { usePreferences, usePreferencesBoot } from '../personalization/preferencesStore';
import ActiveTourScreen from '../screens/ActiveTourScreen';
import DeleteAccountScreen from '../screens/DeleteAccountScreen';
import DiscoveryScreen from '../screens/DiscoveryScreen';
import OnboardingCityScreen from '../screens/onboarding/OnboardingCityScreen';
import OnboardingGroupScreen from '../screens/onboarding/OnboardingGroupScreen';
import OnboardingInterestsScreen from '../screens/onboarding/OnboardingInterestsScreen';
import OnboardingTimeScreen from '../screens/onboarding/OnboardingTimeScreen';
import WelcomeScreen from '../screens/onboarding/WelcomeScreen';
import SettingsScreen from '../screens/SettingsScreen';
import TourDetailScreen from '../screens/TourDetailScreen';
import { useAuth } from '../services/auth/authStore';
import { routeAfterAuthChange } from './accountGuard';
import { navigationRef } from './navigationRef';
import type { RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Root stack: Welcome -> [City] -> Group -> Interests -> Time -> Discovery ->
 * TourDetail -> ActiveTour.
 *
 * Onboarding (TASK-601, Welcome and City since TASK-1101) is ordinary stack
 * screens rather than a pager, so back and the iOS edge-swipe step between them
 * natively. They stay registered after onboarding so Discovery can reopen them
 * to edit preferences or switch city; finishing resets the stack onto Discovery.
 *
 * Where a launch starts: Welcome until it has been answered once (signed in or
 * guest), then the first unfinished step, then Discovery. Welcome is never
 * shown again after that - signing out returns the app to guest, not to it.
 *
 * The navigator is not mounted until saved preferences have been read back:
 * initialRouteName is consulted exactly once, so mounting early would send every
 * returning user through onboarding. The wait is one AsyncStorage read.
 *
 * AudioPlayerSheet is rendered here as a SIBLING of the Navigator but a CHILD of
 * NavigationContainer (TASK-102 approach B). Being outside the navigator's
 * screen tree is what keeps it mounted across navigation, so a running tour's
 * player survives the user browsing back to Discovery.
 *
 * Route awareness comes from `onStateChange` rather than a hook: navigation
 * hooks need a navigator context that a sibling of the Navigator does not have.
 * See navigationRef.ts.
 *
 * ActiveTour hides the back button and disables the swipe gesture. A running
 * tour owns a background location service and an audio player; an edge-swipe
 * unmounting the screen would be harmless to the session now, but leaving
 * mid-tour should still be a deliberate act with teardown attached.
 */
export default function RootNavigator() {
  const [routeName, setRouteName] = useState<string | undefined>(undefined);
  const preferencesReady = usePreferencesBoot((s) => s.ready);
  const onboarded = usePreferences((s) => s.onboardingComplete);
  const welcomeSeen = usePreferences((s) => s.welcomeSeen);

  const syncRoute = useCallback(() => {
    setRouteName(navigationRef.getCurrentRoute()?.name);
  }, []);

  // Account-only screens follow the auth state (accountGuard.ts). A zustand
  // subscription, not a render-time hook: it runs synchronously INSIDE the
  // setState that signed the user out, before React renders anything, so the
  // screen is left in the same turn as the purge.
  useEffect(
    () =>
      useAuth.subscribe((state, previous) => {
        if (!navigationRef.isReady()) return;
        const target = routeAfterAuthChange(previous.status, state.status, navigationRef.getCurrentRoute()?.name);
        if (target !== null) navigationRef.reset({ index: 0, routes: [{ name: target }] });
      }),
    [],
  );

  if (!preferencesReady) return null;

  return (
    <NavigationContainer ref={navigationRef} onReady={syncRoute} onStateChange={syncRoute}>
      <Stack.Navigator
        initialRouteName={!welcomeSeen ? 'Welcome' : onboarded ? 'Discovery' : 'OnboardingGroup'}
        screenOptions={{
          headerTitleStyle: { fontWeight: '600' },
          contentStyle: { backgroundColor: '#FFFFFF' },
        }}
      >
        <Stack.Group screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Welcome" component={WelcomeScreen} />
          <Stack.Screen name="OnboardingCity" component={OnboardingCityScreen} />
          <Stack.Screen name="OnboardingGroup" component={OnboardingGroupScreen} />
          <Stack.Screen name="OnboardingInterests" component={OnboardingInterestsScreen} />
          <Stack.Screen name="OnboardingTime" component={OnboardingTimeScreen} />
        </Stack.Group>

        <Stack.Screen name="Discovery" component={DiscoveryScreen} options={{ title: 'Audio Tours' }} />
        <Stack.Screen
          name="TourDetail"
          component={TourDetailScreen}
          options={({ route }) => ({ title: route.params.title })}
        />
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
        <Stack.Screen
          name="DeleteAccount"
          component={DeleteAccountScreen}
          // No swipe-away mid-deletion; the screen's own buttons are the exits.
          options={{ title: 'Delete account', gestureEnabled: false }}
        />
        <Stack.Screen
          name="ActiveTour"
          component={ActiveTourScreen}
          options={{ title: 'Tour in progress', headerBackVisible: false, gestureEnabled: false }}
        />
      </Stack.Navigator>

      <AudioPlayerSheet routeName={routeName} />
    </NavigationContainer>
  );
}
