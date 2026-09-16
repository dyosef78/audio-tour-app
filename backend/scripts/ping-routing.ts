/**
 * TASK-702 - one live request to the configured Valhalla endpoint.
 *
 * The only check that talks to the real provider: it proves the key, the URL,
 * the auth style (`api_key`) and the response shape that test-routing.ts stubs.
 * Costs one routing request. Skips, exit 0, when no key is configured.
 *
 * Run:  npm run routing:ping    (reads .env, then mobile/.env)
 */

import { ValhallaClient, isRoutingError, valhallaConfigFromEnv } from '../../shared/src/routing/index.ts';

// Jaffa Gate -> Tower of David -> Church of the Holy Sepulchre: a few hundred
// metres of Old City lanes, routable on foot, cheap to compute.
const STOPS = [
  [35.2285, 31.7766],
  [35.2279, 31.7762],
  [35.2297, 31.7784],
] as const;

if (!process.env.STADIA_API_KEY && !process.env.VALHALLA_ROUTE_URL) {
  console.log('SKIP  STADIA_API_KEY (or VALHALLA_ROUTE_URL) is not set - nothing to ping.');
  process.exit(0);
}

try {
  const client = new ValhallaClient(valhallaConfigFromEnv(process.env));
  const started = Date.now();
  const route = await client.route(STOPS, 'pedestrian');
  console.log(`OK    ${Date.now() - started} ms`);
  console.log(`      ${route.distanceMeters} m, ${route.durationSeconds} s, ${route.legs.length} legs`);
  console.log(`      stop offsets from route (m): ${route.locationOffsetsMeters.join(', ')}`);
  console.log(`      polyline (precision ${route.precision}, ${route.polyline.length} chars): ${route.polyline.slice(0, 60)}...`);
} catch (error) {
  if (isRoutingError(error)) {
    console.error(`FAIL  ${error.code}: ${error.message}`);
    if (error.status !== undefined) console.error(`      HTTP ${error.status}${error.providerCode ? `, Valhalla ${error.providerCode}` : ''}`);
    if (error.detail) console.error(`      ${error.detail}`);
  } else {
    console.error('FAIL ', error);
  }
  process.exit(1);
}
