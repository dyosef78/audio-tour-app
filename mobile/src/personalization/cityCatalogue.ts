import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { fetchCities } from '../services/supabase/cities';
import type { CitySummary } from './onboardingFlow';

/**
 * The cities the server last offered (TASK-1101), kept on the device.
 *
 * Persisted so an offline Discovery can still name the saved city, and so a
 * returning visitor's onboarding does not wait on the network. `null` means
 * "never fetched", which resolveCity treats as unknown - distinct from an
 * empty list the server actually returned.
 */

interface CityCatalogueState {
  cities: CitySummary[] | null;
}

export const useCityCatalogue = create<CityCatalogueState>()(
  persist((): CityCatalogueState => ({ cities: null }), {
    name: 'city-catalogue',
    version: 1,
    storage: createJSONStorage(() => AsyncStorage),
  }),
);

let inFlight: Promise<boolean> | null = null;

/**
 * Fetch the list once, however many screens ask at the same moment.
 *
 * Resolves true when a fresh list was stored. A failure keeps the previous list:
 * a dead connection is not evidence that a city went away. Before migration
 * 20260918090000 the table does not exist, which lands here too.
 */
export function refreshCities(fetcher: () => Promise<CitySummary[]> = fetchCities): Promise<boolean> {
  if (inFlight !== null) return inFlight;
  inFlight = (async () => {
    try {
      const cities = await fetcher();
      useCityCatalogue.setState({ cities });
      return true;
    } catch (err) {
      console.warn('[Cities] could not refresh the city list:', err instanceof Error ? err.message : err);
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** refreshCities, but never waits longer than `ms`: onboarding must not hang on a slow network. */
export function refreshCitiesWithin(ms: number, fetcher?: () => Promise<CitySummary[]>): Promise<boolean> {
  return Promise.race([
    refreshCities(fetcher),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}
