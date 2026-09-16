import AsyncStorage from '@react-native-async-storage/async-storage';

import type { RouteCacheStore } from '../../routing/RouteManager';
import { parseEncodedRoute } from '../../routing/routeGeometry';

/**
 * Disk cache for live routes (TASK-604), one entry per visiting order (TASK-903).
 *
 * This is what makes the online path useful to an offline-first app: the
 * realistic moment of connectivity is BEFORE the walk (hotel WiFi, the
 * download), not during it. A route fetched then is on disk when the signal
 * goes, and the next session with the same stops reads it back with no network.
 *
 * Stored in the wire shape, so a read goes through the same parser as a
 * response. Keys are built by routeCacheKey(): the bundle hash and the ORDERED
 * stop ids, so a morning order and a sunset order for the same stops are two
 * entries. The order is the key itself, never stored in the value. Nothing is
 * evicted: entries are a few kB, and orders per tour are bounded by the time
 * windows and preference combinations the sorter distinguishes.
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
