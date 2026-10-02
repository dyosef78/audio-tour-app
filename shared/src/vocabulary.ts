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
export type Interest = (typeof INTEREST_IDS)[number];
