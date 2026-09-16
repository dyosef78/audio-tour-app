import AsyncStorage from '@react-native-async-storage/async-storage';

import type { RouteCacheStore } from '../../routing/RouteManager';
import { parseEncodedRoute } from '../../routing/routeGeometry';

/**
 * Disk cache for routes fetched through a subset of stops (TASK-604).
 *
 * This is what makes the online path useful to an offline-first app: the
 * realistic moment of connectivity is BEFORE the walk (hotel WiFi, the
 * download), not during it. A route fetched then is on disk when the signal
 * goes, and the next session with the same stops reads it back with no network.
 *
 * Stored in the wire shape, so a read goes through the same parser as a
 * response. Keys are built by routeCacheKey() and include the bundle hash.
 * Never throws: a cache is an optimisation, not a dependency.
 */
export const RouteCache: RouteCacheStore = {
  async get(key) {
    try {
      const raw = await AsyncStorage.getItem(key);
      return raw === null ? null : parseEncodedRoute(JSON.parse(raw));
    } catch {
      return null;
    }
  },

  async set(key, route) {
    try {
      await AsyncStorage.setItem(
        key,
        JSON.stringify({
          encoding: 'polyline',
          precision: route.precision,
          polyline: route.polyline,
          length_meters: route.lengthMeters,
        }),
      );
    } catch {
      // Lost cache entry: the next online session fetches again.
    }
  },
};
