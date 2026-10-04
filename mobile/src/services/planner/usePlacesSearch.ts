import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { PlaceSuggestion } from '../../../../shared/src/contracts/places';
import { uuidV4 } from '../telemetry/TelemetryService';
import { PlacesSession, type PlacesView } from './places';
import { placesClient } from './index';

const IDLE: PlacesView = { query: '', suggestions: [], status: 'idle', error: null };

/**
 * The search field's view of a PlacesSession. One session per mounted screen
 * per city: a city change starts a fresh one (its bias and its token belong to
 * the old city), and unmounting disposes it - aborting the request in flight
 * and guaranteeing onSelected never fires into a screen that has gone.
 *
 * onSelected is read through a ref, so a new callback each render does not
 * recreate the session (which would throw away the token mid-search).
 */
export function usePlacesSearch(cityId: string | null, onSelected: (origin: { lon: number; lat: number; label: string }) => void) {
  const onSelectedRef = useRef(onSelected);
  onSelectedRef.current = onSelected;

  const [session, setSession] = useState<PlacesSession | null>(null);
  useEffect(() => {
    if (cityId === null) {
      setSession(null);
      return;
    }
    const s = new PlacesSession({
      client: placesClient,
      cityId,
      uuid: uuidV4,
      now: Date.now,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      onSelected: (origin) => onSelectedRef.current(origin),
    });
    setSession(s);
    return () => s.dispose();
  }, [cityId]);

  const view = useSyncExternalStore(
    (l) => session?.subscribe(l) ?? (() => {}),
    () => session?.view ?? IDLE,
  );

  return {
    view,
    setQuery: (text: string) => session?.setQuery(text),
    select: (s: PlaceSuggestion) => void session?.select(s),
  };
}
