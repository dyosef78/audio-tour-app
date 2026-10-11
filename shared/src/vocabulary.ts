/**
 * Epic 16 - the onboarding tag vocabulary, shared by app, Edge Functions and contracts.
 *
 * Moved here from mobile/src/personalization/options.ts so a contract in
 * shared/ (contracts/planTour.ts) can name these types; options.ts re-exports
 * them and keeps the labels. The ids are a STORAGE CONTRACT: persisted on
 * devices, and enforced by audience_tag_vocabulary() / interest_tag_vocabulary()
 * CHECKs in the database. `npm run test:cms` fails if this file, options.ts and
 * the migrations drift. Rename a label freely, never an id.
 *
 * Runtime-neutral (Metro, Node, Deno): no imports.
 */

export const GROUP_TYPE_IDS = ['solo', 'couple', 'friends', 'family_kids'] as const;
export const INTEREST_IDS = ['history', 'culinary', 'nature', 'architecture', 'art_culture'] as const;

export type GroupType = (typeof GROUP_TYPE_IDS)[number];

/**
 * Epic 17 (PM, Option A): an optional refinement of group_type 'family_kids'
 * for the plan request. A request field only - NOT a database tag: it is in
 * no CHECK, no column and no vocabulary function, and only sets walking pace.
 *
 * Children who listen to a story, roughly 4 and up (PM 11 Oct). Babies and
 * strollers are not a band: the tours are not made for them.
 *   young_kids  4-7    kids  8-12    teens  13-17
 * Listed youngest first; a request names one or more (a family's range).
 */
export const KIDS_AGE_BANDS = ['young_kids', 'kids', 'teens'] as const;
export type KidsAgeBand = (typeof KIDS_AGE_BANDS)[number];
export type Interest = (typeof INTEREST_IDS)[number];

/**
 * Epic 16: a waypoint's role (waypoints_stop_role_check). A catalogue session
 * plays every 'core' stop and nothing else; 'extension' stops exist only in
 * planned bundles. A manifest saved before Epic 16 has no role: read as core.
 */
export const STOP_ROLES = ['core', 'extension'] as const;
export type StopRole = (typeof STOP_ROLES)[number];
