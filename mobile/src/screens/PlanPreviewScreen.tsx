import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { PlanPreviewScreenProps } from '../navigation/types';
import { TourBundleRepository } from '../services/bundle/TourBundleRepository';
import { planClient } from '../services/planner';
import type { PlanDownloadOutcome } from '../services/planner/planDownload';
import { estimateSummary, formatDistance, formatDuration, localIsoWithOffset, planErrorCopy, segmentRows, upsellCopy, type SegmentRow } from '../services/planner/planForm';
import { pinConflictCopy } from '../services/planner/planRepository';
import { savedPlans, useSavedPlans } from '../services/planner/planRepositoryFile';
import { planDownloads, usePlanDownload, usePlanReconciler } from '../services/planner/planRuntime';
import { fetchTours } from '../services/supabase/tours';
import { useTourSession } from '../session/tourSessionStore';
import { colors, MIN_TOUCH } from '../ui/theme';

/**
 * A plan, before and after it is kept (Epic 16 final slice).
 *
 * Reads the plan from the plan repository by id - never from params - so a
 * plan deleted elsewhere (strict invalidation by another plan or a tour
 * update) shows as gone instead of lingering as a stale copy.
 *
 * ON MOUNT, usePlanReconciler squares the plan file with the bundles on disk
 * (planReconciler.ts): a draft whose download completed but whose save was
 * lost is promoted; a saved plan whose bundles are gone is removed, and this
 * screen says why.
 *
 * "Download & save" starts the plan's download JOB (planRuntime): owned by the
 * app, one per plan, finishing and saving whether or not this screen is still
 * mounted. The screen only shows the job and answers its outcomes:
 *   conflict  a SAVED plan pins another version of a tour this plan needs ->
 *             the PM's dialog (pinConflictCopy 'new_plan'); on Overwrite the
 *             job restarts with those plans agreed
 *   stale     a tour changed since planning -> re-plan ONCE with the same
 *             request (route param `replanned` stops a loop)
 * An outcome that lands while the visitor is elsewhere waits in the job and is
 * answered on the next visit.
 */

type Local = { phase: 'idle' } | { phase: 'replanning' } | { phase: 'error'; title: string; message: string };

const REMOVED_COPY: Record<'bundle_missing' | 'bundle_changed' | 'plan_invalid', string> = {
  bundle_missing: 'One of its tours is no longer on this device.',
  bundle_changed: 'One of its tours was replaced by another version on this device.',
  plan_invalid: 'It no longer matches the tours on this device.',
};

export default function PlanPreviewScreen({ route, navigation }: PlanPreviewScreenProps) {
  const { planId, replanned = false } = route.params;
  const report = usePlanReconciler();
  const saved = useSavedPlans().find((p) => p.plan.plan_id === planId) ?? null;
  const job = usePlanDownload(planId);
  const [local, setLocal] = useState<Local>({ phase: 'idle' });
  const [tourTitles, setTourTitles] = useState<ReadonlyMap<string, string>>(new Map());
  // Plans the visitor agreed to overwrite, across this visit's retries.
  const agreed = useRef<string[]>([]);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A running tour plays from its bundle directory: replacing it would silence it.
  const runningTourId = useTourSession((s) => (s.status === 'active' || s.status === 'starting' ? s.tourId : null));

  const cityId = saved?.request.city_id ?? null;
  useEffect(() => {
    if (cityId === null) return;
    let live = true;
    fetchTours(cityId)
      .then((tours) => live && setTourTitles(new Map(tours.map((t) => [t.id, t.title]))))
      // Titles only: manifests and placeholders still label every row.
      .catch((err: unknown) => console.warn('[PlanPreview] tour titles unavailable:', err instanceof Error ? err.message : err));
    return () => {
      live = false;
    };
  }, [cityId]);

  // job.running is a dependency on purpose: a finished job means new manifests, so new chapter titles.
  const rows = useMemo(() => {
    if (saved === null) return [];
    return segmentRows(saved.plan, {
      chapterTitle: (tourId, chapterId) => TourBundleRepository.readManifest(tourId)?.chapters?.find((c) => c.chapter_id === chapterId)?.title ?? null,
      tourTitle: (tourId) => tourTitles.get(tourId) ?? TourBundleRepository.readManifest(tourId)?.tour_metadata.title ?? null,
    });
  }, [saved, tourTitles, job.running]);

  const replan = useCallback(async () => {
    if (saved === null) return;
    setLocal({ phase: 'replanning' });
    const request = { ...saved.request, context: { local_time: localIsoWithOffset(new Date()) } };
    const result = await planClient.plan(request);
    if (!mounted.current) return;
    if (result.kind === 'error') {
      setLocal({ phase: 'error', ...planErrorCopy(result) });
      return;
    }
    savedPlans.putDraft({ plan: result.plan, request, originLabel: saved.originLabel, savedAt: Date.now() });
    navigation.replace('PlanPreview', { planId: result.plan.plan_id, replanned: true });
  }, [saved, navigation]);

  const startDownload = useCallback(() => {
    setLocal({ phase: 'idle' });
    // The job outlives this screen; its outcome comes back through the effect below.
    void planDownloads.start(planId, agreed.current);
  }, [planId]);

  const answer = useCallback(
    (outcome: Exclude<PlanDownloadOutcome, { kind: 'ready' }>) => {
      switch (outcome.kind) {
        case 'conflict': {
          const copy = pinConflictCopy(outcome.blocking, 'new_plan');
          Alert.alert(copy.title, copy.message, [
            { text: 'Keep old plan', style: 'cancel' },
            {
              text: copy.confirm,
              style: 'destructive',
              onPress: () => {
                agreed.current = [...agreed.current, ...outcome.blocking.map((b) => b.planId)];
                startDownload();
              },
            },
          ]);
          return;
        }
        case 'stale':
        case 'invalid':
          // The tours moved on since planning (invalid: the plan no longer
          // matches the bundle it pinned - the same remedy). Once only.
          if (!replanned) {
            void replan();
            return;
          }
          setLocal({ phase: 'error', title: 'Tours are being updated', message: "This city's tours changed while we were planning. Please try again in a few minutes." });
          return;
        case 'failed':
          setLocal({ phase: 'error', title: 'Download failed', message: `${outcome.message} Finished parts are kept, so trying again continues where it stopped.` });
          return;
      }
    },
    [replanned, replan, startDownload],
  );

  // Take the job's outcome - now, or on the next visit if it landed while away.
  useEffect(() => {
    if (job.outcome === null) return;
    const outcome = planDownloads.take(planId);
    if (outcome !== null) answer(outcome);
  }, [job.outcome, planId, answer]);

  const deletePlan = useCallback(() => {
    Alert.alert('Delete this plan?', 'The downloaded tours stay on your device.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete plan',
        style: 'destructive',
        onPress: () => {
          savedPlans.remove([planId]);
          navigation.goBack();
        },
      },
    ]);
  }, [planId, navigation]);

  if (saved === null) {
    const removed = report?.actions.find((a) => a.kind === 'remove' && a.planId === planId);
    return (
      <View style={styles.centered}>
        <Text style={styles.h2}>This plan is gone</Text>
        <Text style={styles.muted}>
          {removed?.kind === 'remove'
            ? `${REMOVED_COPY[removed.reason]} Plan again to get a fresh route.`
            : 'It was deleted, or replaced when one of its tours was updated.'}
        </Text>
        <Pressable style={styles.primary} onPress={() => navigation.goBack()} accessibilityRole="button">
          <Text style={styles.primaryText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  const { plan } = saved;
  const est = estimateSummary(plan);
  const upsell = upsellCopy(plan);
  const blockedByRunningTour =
    runningTourId !== null &&
    plan.sources.some((s) => s.tour_id === runningTourId && TourBundleRepository.readManifest(s.tour_id)?.bundle_version_hash !== s.bundle_version_hash);
  const busy = job.running || local.phase === 'replanning';
  // Asked for before, not running now: a kill or a failure interrupted it.
  const resumable = saved.downloadRequestedAt !== null && !job.running;
  const dl = job.running ? { phase: 'downloading' as const, fraction: job.fraction } : local;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.card}>
        <Text style={styles.eyebrow}>FROM {saved.originLabel.toUpperCase()}</Text>
        <Text style={styles.total}>
          {est.approximate ? 'About ' : ''}
          {est.total}
          <Text style={styles.of}> of your {formatDuration(plan.estimate.budget_s)}</Text>
        </Text>
        <Text style={styles.hint}>
          {formatDuration(plan.estimate.transfer_s)} getting between tours · {formatDuration(plan.estimate.chapter_travel_s + plan.estimate.dwell_s)} on tour
        </Text>
        {est.slack !== null && <Text style={styles.hint}>{est.slack} to spare</Text>}
        {est.deepDiveExtra !== null && <Text style={styles.hint}>Deep Dives would add about {est.deepDiveExtra}</Text>}
        {est.approximate && <Text style={styles.hint}>Some travel times are estimates.</Text>}
      </View>

      {upsell !== null && (
        <Pressable style={({ pressed }) => [styles.upsell, pressed && styles.pressed]} onPress={() => navigation.popTo('Plan')} accessibilityRole="button" accessibilityHint="Back to the planner to add time">
          <Text style={styles.upsellTitle}>✨ {upsell}</Text>
          <Text style={styles.link}>Add more time</Text>
        </Pressable>
      )}

      <View>
        {rows.map((r) => (
          <SegmentRowView key={r.key} row={r} />
        ))}
      </View>

      {saved.status === 'saved' ? (
        <View style={styles.savedCard}>
          <Text style={styles.savedText}>✓ Saved — every tour is on your device</Text>
        </View>
      ) : (
        <>
          {dl.phase === 'downloading' && (
            <View style={styles.track} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(dl.fraction * 100) }}>
              <View style={[styles.fill, { width: `${Math.round(dl.fraction * 100)}%` }]} />
            </View>
          )}
          {dl.phase === 'error' && (
            <View style={styles.errorCard} accessibilityRole="alert">
              <Text style={styles.errorTitle}>{dl.title}</Text>
              <Text style={styles.errorText}>{dl.message}</Text>
            </View>
          )}
          {blockedByRunningTour && <Text style={styles.hint}>One of these tours is playing now. You can download this plan once it ends.</Text>}
          <Pressable
            style={[styles.primary, (busy || blockedByRunningTour) && styles.disabled]}
            disabled={busy || blockedByRunningTour}
            onPress={startDownload}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy || blockedByRunningTour, busy }}
          >
            {busy ? <ActivityIndicator color={colors.canvas} /> : <Text style={styles.primaryText}>{dl.phase === 'error' ? 'Try again' : resumable ? 'Resume download' : 'Download & save plan'}</Text>}
          </Pressable>
        </>
      )}

      {!busy && (
        <Pressable onPress={deletePlan} hitSlop={8} style={styles.deleteRow} accessibilityRole="button">
          <Text style={styles.delete}>{saved.status === 'saved' ? 'Delete plan' : 'Discard plan'}</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

const MODE_ICON = { walking: '🚶', biking: '🚲', driving: '🚗' } as const;

function SegmentRowView({ row }: { row: SegmentRow }) {
  if (row.kind === 'transfer') {
    return (
      <View style={styles.transfer}>
        <Text style={styles.transferText}>
          {MODE_ICON[row.mode]} {row.estimated ? 'about ' : ''}
          {formatDuration(row.durationS)} · {formatDistance(row.distanceM)}
          {row.fromOrigin ? ' from your start' : ''}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.chapter}>
      <Text style={styles.chapterTitle}>{row.title}</Text>
      {row.tourTitle !== null && row.tourTitle !== row.title && <Text style={styles.hint}>{row.tourTitle}</Text>}
      <Text style={styles.hint}>
        {row.stops} {row.stops === 1 ? 'stop' : 'stops'}
        {row.extensions > 0 ? ` (${row.extensions} picked for you)` : ''} · {row.estimated ? 'about ' : ''}
        {formatDuration(row.durationS)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 16, paddingBottom: 48 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  h2: { fontSize: 17, fontWeight: '600', color: colors.ink },
  muted: { fontSize: 14, color: colors.inkMuted, textAlign: 'center', lineHeight: 20 },
  hint: { fontSize: 13, color: colors.inkMuted, lineHeight: 18 },
  link: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  card: { padding: 16, borderRadius: 14, backgroundColor: colors.surface, gap: 4 },
  eyebrow: { fontSize: 12, fontWeight: '700', letterSpacing: 0.8, color: colors.accent },
  total: { fontSize: 26, fontWeight: '700', color: colors.ink },
  of: { fontSize: 16, fontWeight: '400', color: colors.inkMuted },
  upsell: { padding: 14, borderRadius: 12, borderWidth: 1.5, borderColor: colors.accent, backgroundColor: colors.accentSoft, gap: 6 },
  upsellTitle: { fontSize: 14, lineHeight: 19, color: colors.ink },
  pressed: { opacity: 0.7 },
  transfer: { marginLeft: 14, paddingLeft: 16, paddingVertical: 10, borderLeftWidth: 2, borderLeftColor: colors.hairline, borderStyle: 'dashed' },
  transferText: { fontSize: 13, color: colors.inkSecondary },
  chapter: { padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.hairline, gap: 3 },
  chapterTitle: { fontSize: 16, fontWeight: '600', color: colors.ink },
  savedCard: { padding: 14, borderRadius: 12, backgroundColor: '#E6F4EA' },
  savedText: { fontSize: 15, fontWeight: '600', color: '#1B7A45' },
  errorCard: { padding: 14, borderRadius: 12, backgroundColor: '#FBF0E0', gap: 4 },
  errorTitle: { fontSize: 15, fontWeight: '700', color: '#8A5A00' },
  errorText: { fontSize: 14, lineHeight: 19, color: '#6B4A12' },
  track: { height: 8, borderRadius: 4, backgroundColor: '#E4E4E8', overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4, backgroundColor: colors.ink },
  primary: { minHeight: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: colors.ink },
  primaryText: { color: colors.canvas, fontWeight: '600', fontSize: 16 },
  disabled: { opacity: 0.4 },
  deleteRow: { minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  delete: { fontSize: 14, color: colors.dangerInk, fontWeight: '600' },
});
