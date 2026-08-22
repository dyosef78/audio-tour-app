import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';

import AudioPlayerSheet from '../components/AudioPlayerSheet';
import ActiveTourScreen from '../screens/ActiveTourScreen';
import DiscoveryScreen from '../screens/DiscoveryScreen';
import TourDetailScreen from '../screens/TourDetailScreen';
import { navigationRef } from './navigationRef';
import type { RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Root stack: Discovery -> TourDetail -> ActiveTour, mirroring the PRD screens.
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

  const syncRoute = useCallback(() => {
    setRouteName(navigationRef.getCurrentRoute()?.name);
  }, []);

  return (
    <NavigationContainer ref={navigationRef} onReady={syncRoute} onStateChange={syncRoute}>
      <Stack.Navigator
        initialRouteName="Discovery"
        screenOptions={{
          headerTitleStyle: { fontWeight: '600' },
          contentStyle: { backgroundColor: '#FFFFFF' },
        }}
      >
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
