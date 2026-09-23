/**
 * Personalisation catalogue and route criteria (TASK-601).
 *
 * Pure - no React Native, no storage - so the route generator in TASK-603 and
 * the Node harness can both import it.
 *
 * The ids are a STORAGE CONTRACT. They are persisted on the device, and since
 * TASK-603 they are also the database tag vocabulary - audience_tag_vocabulary()
 * and interest_tag_vocabulary() in migration 20260915120000, enforced by CHECK
 * constraints. Rename a label freely, never an id; `npm run test:cms` fails if
 * the two lists drift.
 */

export type GroupType = 'solo' | 'couple' | 'friends' | 'family_kids';
export type Interest = 'history' | 'culinary' | 'nature' | 'architecture' | 'art_culture';
export type TimeBudget = 'quick' | 'half_day' | 'full_day';

export interface ChoiceOption<Id extends string> {
  id: Id;
  label: string;
  description: string;
  /** A glyph, so the cards read at a glance without shipping image assets. */
  icon: string;
}

export const GROUP_TYPES: readonly ChoiceOption<GroupType>[] = [
  { id: 'solo', label: 'Solo', description: 'At your own pace', icon: '🚶' },
  { id: 'couple', label: 'Couple', description: 'Two of you, unhurried', icon: '👫' },
  { id: 'friends', label: 'Friends', description: 'A small group', icon: '🧑‍🤝‍🧑' },
  { id: 'family_kids', label: 'Family with kids', description: 'Shorter stops, more breaks', icon: '👨‍👩‍👧' },
];

export const INTERESTS: readonly ChoiceOption<Interest>[] = [
  { id: 'history', label: 'History', description: 'Stories behind the streets', icon: '🏛️' },
  // One tag, PM decision (Epic 11): street food, markets and fine dining are how
  // the screen SELLS culinary, not separate ids - more tags would filter stops harder.
  { id: 'culinary', label: 'Culinary', description: 'Street food, markets, fine dining', icon: '🍽️' },
  { id: 'nature', label: 'Nature', description: 'Parks, gardens, the sea', icon: '🌳' },
  { id: 'architecture', label: 'Architecture', description: 'Buildings and design', icon: '🏙️' },
  { id: 'art_culture', label: 'Art & Culture', description: 'Museums, theatre, music', icon: '🎭' },
];

export interface TimeBudgetOption extends ChoiceOption<TimeBudget> {
  /** Upper bound on total tour time, in minutes. */
  maxMinutes: number;
}

/**
 * PM-confirmed at Epic 11 kickoff: 120 / 240 / 480 minutes. These pick which
 * TOURS Discovery puts first; they never cut stops out of a route. `quick` was
 * 60 minutes before TASK-1101 - the id is kept, since it is stored on devices.
 */
export const TIME_BUDGETS: readonly TimeBudgetOption[] = [
  { id: 'quick', label: '2 hours', description: 'A focused walk', icon: '⏱️', maxMinutes: 120 },
  { id: 'half_day', label: 'Half day', description: 'Up to four hours', icon: '🌤️', maxMinutes: 240 },
  { id: 'full_day', label: 'Full day', description: 'Up to eight hours', icon: '🗺️', maxMinutes: 480 },
];

const GROUP_TYPE_IDS: ReadonlySet<string> = new Set(GROUP_TYPES.map((o) => o.id));
const INTEREST_IDS: ReadonlySet<string> = new Set(INTERESTS.map((o) => o.id));

/**
 * Tags from a bundle, narrowed to the ids this build knows.
 *
 * The server vocabulary can widen before an app update ships; an unknown tag
 * is dropped rather than carried as a value no label or filter can handle.
 */
export function parseGroupTypes(values: unknown): GroupType[] {
  return Array.isArray(values)
    ? values.filter((v): v is GroupType => typeof v === 'string' && GROUP_TYPE_IDS.has(v))
    : [];
}

export function parseInterests(values: unknown): Interest[] {
  return Array.isArray(values)
    ? values.filter((v): v is Interest => typeof v === 'string' && INTEREST_IDS.has(v))
    : [];
}

export function labelFor<Id extends string>(options: readonly ChoiceOption<Id>[], id: Id): string {
  return options.find((o) => o.id === id)?.label ?? id;
}

/** The inputs route generation consumes. Only exists once onboarding is complete. */
export interface RouteCriteria {
  groupType: GroupType;
  interests: readonly Interest[];
  maxMinutes: number;
}

export function routeCriteria(prefs: {
  groupType: GroupType | null;
  interests: readonly Interest[];
  timeBudget: TimeBudget | null;
}): RouteCriteria | null {
  if (prefs.groupType === null || prefs.timeBudget === null || prefs.interests.length === 0) {
    return null;
  }
  const budget = TIME_BUDGETS.find((b) => b.id === prefs.timeBudget);
  if (!budget) return null;
  return { groupType: prefs.groupType, interests: prefs.interests, maxMinutes: budget.maxMinutes };
}

/**
 * Whether a whole tour fits the time budget.
 *
 * The one preference the catalogue can honour TODAY: tours carry
 * duration_minutes, but waypoints carry no interest or audience tags yet. See
 * the TASK-601 handover. Null means "no opinion", not "does not fit".
 */
export function tourFitsBudget(durationMinutes: number, criteria: RouteCriteria | null): boolean | null {
  if (criteria === null) return null;
  return durationMinutes <= criteria.maxMinutes;
}
