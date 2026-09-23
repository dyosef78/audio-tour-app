import { parseCities, type CitySummary } from '../../personalization/onboardingFlow';
import { supabase } from './client';

/**
 * Cities for onboarding and Discovery (TASK-1101).
 *
 * RLS (cities_read_with_published_tour) already limits the result to cities
 * with at least one published tour, so every row here is a real choice.
 */
export async function fetchCities(): Promise<CitySummary[]> {
  const { data, error } = await supabase.from('cities').select('id, slug, name').order('name');
  if (error) throw new Error(error.message);
  return parseCities(data);
}
