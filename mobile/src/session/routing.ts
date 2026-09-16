import { RouteManager } from '../routing/RouteManager';
import { networkMonitor } from '../services/network/NetworkMonitor';
import { RouteCache } from '../services/routing/RouteCache';
import { fetchDynamicRoute } from '../services/routing/DynamicRouteClient';
import { deviceLocalTime } from '../routing/routeRequest';
import { useTourSession } from './tourSessionStore';

/**
 * The app's one RouteManager, wired to the real network, endpoint, cache and
 * store. Kept apart from RouteManager itself so the manager stays free of
 * native imports and testable in Node.
 */
export const routeManager = new RouteManager({
  network: networkMonitor,
  fetchRoute: fetchDynamicRoute,
  cache: RouteCache,
  publish: (route) => useTourSession.getState().setRoute(route),
  localTime: () => deviceLocalTime(),
  schedule: (fn, delayMs) => {
    const timer = setTimeout(fn, delayMs);
    return () => clearTimeout(timer);
  },
  log: (message) => console.log(`[Route] ${message}`),
});
