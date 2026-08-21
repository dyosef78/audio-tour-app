import type { Topology, Tour, TransitMode } from '../../types/domain';
import { supabase } from './client';

/**
 * Tour queries.
 *
 * Kept out of the screens so the fetch can be unit-tested and reused by the
 * bundle downloader (TASK-201) without dragging React in.
 *
 * The row shape is declared locally rather than imported from the repo-root
 * `backend/types/supabase.ts`: that file sits outside the Expo project root, so
 * Metro will not resolve it without extra watchFolders config. Sync note in the
 * handover report.
 */
interface TourRow {
  id: string;
  title: string;
  topology: string;
  transit_mode: string;
  duration_minutes: number;
}

const TOUR_COLUMNS = 'id, title, topology, transit_mode, duration_minutes';

function mapTour(row: TourRow): Tour {
  return {
    id: row.id,
    title: row.title,
    topology: row.topology as Topology,
    transitMode: row.transit_mode as TransitMode,
    durationMinutes: row.duration_minutes,
  };
}

/**
 * Fetch the tour catalogue for Screen 1.
 *
 * Reads with the anon key, so this exercises the public-read RLS policy. An
 * empty array is a legitimate result, not an error - the caller must render an
 * empty state rather than treating it as a failure.
 */
export async function fetchTours(): Promise<Tour[]> {
  const { data, error } = await supabase
    .from('tours')
    .select(TOUR_COLUMNS)
    .order('title');

  if (error) throw new Error(error.message);
  return (data ?? []).map(mapTour);
}

export async function fetchTour(tourId: string): Promise<Tour | null> {
  const { data, error } = await supabase
    .from('tours')
    .select(TOUR_COLUMNS)
    .eq('id', tourId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? mapTour(data) : null;
}
