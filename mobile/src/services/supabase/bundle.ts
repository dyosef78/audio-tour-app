import { supabase } from './client';
import { isWireBundle, type WireBundle } from '../bundle/types';

/**
 * Fetch the complete offline bundle payload for a tour in one round trip.
 *
 * Backed by the `get_tour_bundle` RPC (migration 20260821195300), which decodes
 * PostGIS geometry into [longitude, latitude] pairs and computes a
 * content-derived `bundle_version_hash` the client uses for staleness checks.
 */
export async function fetchTourBundle(tourId: string): Promise<WireBundle> {
  const { data, error } = await supabase.rpc('get_tour_bundle', { p_tour_id: tourId });

  if (error) throw new Error(`Could not fetch tour bundle: ${error.message}`);
  if (data === null || data === undefined) throw new Error('Tour not found.');

  // The RPC is ours, but this response may have crossed a proxy, a stale
  // PostgREST schema cache, or a version skew during deploy. Verify, do not assume.
  if (!isWireBundle(data)) {
    throw new Error('Tour bundle from the server was not in the expected shape.');
  }

  return data;
}
