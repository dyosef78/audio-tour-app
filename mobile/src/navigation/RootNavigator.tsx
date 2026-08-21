import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import ActiveTourScreen from '../screens/ActiveTourScreen';
import DiscoveryScreen from '../screens/DiscoveryScreen';
import TourDetailScreen from '../screens/TourDetailScreen';
import type { RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Root stack: Discovery -> TourDetail -> ActiveTour, mirroring the PRD v2.0.0
 * screen order.
 *
 * ActiveTour hides the back button and disables the swipe-back gesture. A tour
 * in progress owns a background location service and an audio player; letting
 * a stray edge-swipe unmount it would orphan both. Leaving mid-tour needs to be
 * an explicit action with teardown attached (TODO: TASK-105).
 */
export default function RootNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator
        initialRouteName="Discovery"
        screenOptions={{
          headerTitleStyle: { fontWeight: '600' },
          contentStyle: { backgroundColor: '#FFFFFF' },
        }}
      >
        <Stack.Screen
          name="Discovery"
          component={DiscoveryScreen}
          options={{ title: 'Audio Tours' }}
        />
        <Stack.Screen
          name="TourDetail"
          component={TourDetailScreen}
          options={({ route }) => ({ title: route.params.title })}
        />
        <Stack.Screen
          name="ActiveTour"
          component={ActiveTourScreen}
          options={{
            title: 'Tour in progress',
            headerBackVisible: false,
            gestureEnabled: false,
          }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
