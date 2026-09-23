/**
 * Onboarding order and city resolution (TASK-1101).
 *
 * Pure, so `npm run test:ui` checks every branch without a device.
 *
 *   Welcome -> [City] -> Group -> Interests -> Time -> Discovery
 *
 * The City step appears only when there is a real choice to make (PM decision,
 * Epic 11). With one city it is selected silently; with no list at all
 * (offline first run, or a database before migration 20260918090000) it is
 * skipped and Discovery resolves it later. Welcome is not a numbered step.
 */

export interface CitySummary {
  id: string;
  slug: string;
  name: string;
}

export type CityResolution =
  /** The saved city is still offered. */
  | { kind: 'keep' }
  /** Exactly one city: select it without asking. */
  | { kind: 'auto'; cityId: string }
  /** Several cities and no valid saved choice: the visitor must pick. */
  | { kind: 'choose' }
  /** No usable list (offline, not migrated, nothing published): change nothing. */
  | { kind: 'unknown' };

export function resolveCity(cities: readonly CitySummary[] | null, savedCityId: string | null): CityResolution {
  if (cities === null || cities.length === 0) return { kind: 'unknown' };
  if (savedCityId !== null && cities.some((c) => c.id === savedCityId)) return { kind: 'keep' };
  if (cities.length === 1) return { kind: 'auto', cityId: cities[0]!.id };
  return { kind: 'choose' };
}

/**
 * The city to filter the catalogue by, or null for "every tour".
 *
 * `choose` deliberately yields null rather than the stale saved id: a city that
 * lost its last published tour would otherwise leave an empty list behind a
 * prompt the visitor has not answered yet.
 */
export function catalogueCityId(resolution: CityResolution, savedCityId: string | null): string | null {
  switch (resolution.kind) {
    case 'keep':
      return savedCityId;
    case 'auto':
      return resolution.cityId;
    case 'choose':
      return null;
    case 'unknown':
      return savedCityId;
  }
}

export type OnboardingStep = 'OnboardingCity' | 'OnboardingGroup' | 'OnboardingInterests' | 'OnboardingTime';

export function onboardingSteps(includeCity: boolean): OnboardingStep[] {
  const steps: OnboardingStep[] = ['OnboardingGroup', 'OnboardingInterests', 'OnboardingTime'];
  return includeCity ? ['OnboardingCity', ...steps] : steps;
}

/** 1-based position for the progress bar. An editing session numbers the same way. */
export function stepPosition(step: OnboardingStep, includeCity: boolean): { step: number; total: number } {
  const steps = onboardingSteps(includeCity);
  const index = steps.indexOf(step);
  // A City screen opened on its own (from Discovery) is a one-step flow.
  return index === -1 ? { step: 1, total: 1 } : { step: index + 1, total: steps.length };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cities from the wire, narrowed to rows the app can use. Malformed rows are dropped. */
export function parseCities(rows: unknown): CitySummary[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row): CitySummary[] => {
    if (typeof row !== 'object' || row === null) return [];
    const { id, slug, name } = row as Record<string, unknown>;
    return typeof id === 'string' && UUID.test(id) && typeof slug === 'string' && typeof name === 'string' && name.trim() !== ''
      ? [{ id, slug, name }]
      : [];
  });
}

/**
 * The PostgREST `or` filter for a city's catalogue, or null for no filter.
 *
 * Tours with NO city are included on purpose: cms_validate_tour stops one being
 * published, but if one ever is, hiding it everywhere is the worse failure.
 * The id is interpolated into a filter string, so anything but a uuid is
 * refused rather than escaped - it comes from device storage, not the server.
 */
export function cityCatalogueFilter(cityId: string | null): string | null {
  if (cityId === null || !UUID.test(cityId)) return null;
  return `city_id.eq.${cityId},city_id.is.null`;
}
