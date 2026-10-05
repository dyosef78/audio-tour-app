import type { SessionSource } from './progressRepository.ts';

/**
 * Which tour an ENGINE telemetry event belongs to (Epic 16). Pure, so
 * sim:plan checks the rule the controller applies.
 *
 *   an event about a stop      the tour that OWNS the stop (a plan spans tours)
 *   no stop, catalogue session the session's tour
 *   no stop, planned session   none - the session key plan:<id> is not a
 *                              tours.id, and telemetry_events.tour_id is a
 *                              foreign key: one refused row fails its batch
 */
export function engineEventTourId(source: SessionSource, sessionKey: string, stopTourId: string | undefined): string | undefined {
  return stopTourId ?? (source.kind === 'tour' ? sessionKey : undefined);
}
