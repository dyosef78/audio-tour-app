/**
 * Service-role writers for the planner cost tables, shared by plan-tour's fill
 * and warm-costs. Upserts on each table's primary key; computed_at is sent
 * explicitly because the column default only stamps an insert.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { FillDeps } from './costFill.ts';

export function costWriters(admin: SupabaseClient): Pick<FillDeps, 'saveLegs' | 'saveTransfers'> {
  return {
    async saveLegs(rows) {
      const { error } = await admin.from('chapter_leg_costs').upsert(
        rows.map((r) => ({
          chapter_id: r.chapterId, from_node: r.fromNode, to_node: r.toNode, profile: r.profile,
          duration_seconds: r.durationS, distance_meters: r.distanceM, coords_key: r.coordsKey,
          computed_at: new Date().toISOString(),
        })),
        { onConflict: 'chapter_id,from_node,to_node,profile' },
      );
      if (error) throw new Error(`chapter_leg_costs write: ${error.message}`);
    },
    async saveTransfers(rows) {
      const { error } = await admin.from('chapter_travel_matrix').upsert(
        rows.map((r) => ({
          from_chapter_id: r.fromChapterId, to_chapter_id: r.toChapterId, profile: r.profile,
          duration_seconds: r.durationS, distance_meters: r.distanceM, coords_key: r.coordsKey,
          computed_at: new Date().toISOString(),
        })),
        { onConflict: 'from_chapter_id,to_chapter_id,profile' },
      );
      if (error) throw new Error(`chapter_travel_matrix write: ${error.message}`);
    },
  };
}
