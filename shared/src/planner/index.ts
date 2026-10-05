/**
 * Epic 16 planner - pure, deterministic, runtime-neutral (Deno, Node, Metro).
 * The plan-tour Edge Function is its only production caller.
 */

export { DEDUP_RADIUS_M, PLANNER_VERSION, PLAN_TTL_DAYS, MAX_FILL_CELLS, MAX_SEARCH_NODES } from './constants.ts';
export { CandidatesShapeError, parseCandidates } from './candidates.ts';
export type { Candidate, CandidateStop, Pair, PlannerCandidates } from './candidates.ts';
export { CostBook, estimateCost, missingCellKey, UNROUTABLE } from './costBook.ts';
export type { Cost, CostSource, MissingCell } from './costBook.ts';
export { chapterOptions, compareSameValue, optionTime } from './chapterOptions.ts';
export type { ChapterModel, ChapterOption } from './chapterOptions.ts';
export { searchSequence } from './sequence.ts';
export { chooseFillChain, planTour } from './plan.ts';
export type { PlanDraft, PlanOutcome } from './plan.ts';
export { checkPlanRequest, roundOrigin } from './request.ts';
export type { RequestCheck } from './request.ts';
export { canonicalJson, contentHash, requestHash, sha256Hex } from './hash.ts';
export type { HashedChapter } from './hash.ts';
export { neededCells, parseWarmState, reconcile, TRANSFER_RADIUS_M, WarmStateShapeError } from './warm.ts';
export type { Reconciliation, WarmChapter, WarmState } from './warm.ts';
