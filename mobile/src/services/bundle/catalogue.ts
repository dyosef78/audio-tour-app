import type { Topology, Tour, TransitMode } from '../../types/domain';
import type { WireBundle } from './types';

/**
 * A downloaded bundle as a catalogue entry (TASK-605).
 *
 * Hybrid Offline-First: with no connection the Discovery screen lists the tours
 * already on the device, built from their manifests, instead of an error that
 * leaves downloaded tours unreachable. Pure, so the harness tests it.
 */
export function tourFromManifest(bundle: WireBundle): Tour {
  const meta = bundle.tour_metadata;
  return {
    id: meta.tour_id,
    title: meta.title || 'Untitled tour',
    topology: meta.topology as Topology,
    transitMode: meta.transit_mode as TransitMode,
    durationMinutes: meta.duration_minutes,
  };
}
