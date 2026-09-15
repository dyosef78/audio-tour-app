import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';

import AudioPlayerSheet from '../components/AudioPlayerSheet';
import { usePreferences, usePreferencesBoot } from '../personalization/preferencesStore';
import ActiveTourScreen from '../screens/ActiveTourScreen';
import DiscoveryScreen from '../screens/DiscoveryScreen';
import OnboardingGroupScreen from '../screens/onboarding/OnboardingGroupScreen';
import OnboardingInterestsScreen from '../screens/onboarding/OnboardingInterestsScreen';
import OnboardingTimeScreen from '../screens/onboarding/OnboardingTimeScreen';
import TourDetailScreen from '../screens/TourDetailScreen';
import { navigationRef } from './navigationRef';
import type { RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Root stack: [Onboarding x3] -> Discovery -> TourDetail -> ActiveTour.
 *
 * Onboarding (TASK-601) is three ordinary stack screens rather than a pager, so
 * back and the iOS edge-swipe step between them natively. They stay registered
 * after onboarding so Discovery can reopen them to edit preferences; finishing
 * resets the stack onto Discovery either way.
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

  const syncRoute = useCallback(() => {
    setRouteName(navigationRef.getCurrentRoute()?.name);
  }, []);

  if (!preferencesReady) return null;

  return (
    <NavigationContainer ref={navigationRef} onReady={syncRoute} onStateChange={syncRoute}>
      <Stack.Navigator
        initialRouteName={onboarded ? 'Discovery' : 'OnboardingGroup'}
        screenOptions={{
          headerTitleStyle: { fontWeight: '600' },
          contentStyle: { backgroundColor: '#FFFFFF' },
        }}
      >
        <Stack.Group screenOptions={{ headerShown: false }}>
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
