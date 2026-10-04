import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { PlanPreviewScreenProps } from '../navigation/types';
import { TourBundleRepository } from '../services/bundle/TourBundleRepository';
import { planClient } from '../services/planner';
import { downloadPlanBundles, type PlanDownloadDeps } from '../services/planner/planDownload';
import { estimateSummary, formatDistance, formatDuration, localIsoWithOffset, planErrorCopy, segmentRows, upsellCopy, type SegmentRow } from '../services/planner/planForm';
import { pinConflictCopy } from '../services/planner/planRepository';
import { savedPlans, useSavedPlans } from '../services/planner/planRepositoryFile';
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
 * "Download & save" brings every pinned bundle onto the device at exactly the
 * pinned version (downloadPlanBundles), then marks the plan saved, which is
 * when it starts pinning. On the way:
 *   conflict  a SAVED plan pins another version of a tour this plan needs ->
 *             the PM's dialog (pinConflictCopy 'new_plan'); on Overwrite the
 *             download retries with those plans agreed, and they are deleted
 *             only once the new bundle has committed
 *   stale     a tour changed since planning -> re-plan ONCE with the same
 *             request (route param `replanned` stops a loop)
 *
 * The download outlives this screen on purpose (bytes already fetched are
 * kept); it stops between tours once the screen is gone, and the plan stays a
 * draft - pinning nothing - until a complete run marks it saved.
 */

type Download =
  | { phase: 'idle' }
  | { phase: 'downloading'; fraction: number }
  | { phase: 'replanning' }
  | { phase: 'error'; title: string; message: string };

const deps: PlanDownloadDeps = {
  localHash: (tourId) => TourBundleRepository.readManifest(tourId)?.bundle_version_hash ?? null,
  download: (tourId, o) =>
    TourBundleRepository.download(tourId, {
      invalidatePlans: o.invalidatePlans,
      onProgress: (p) => o.onProgress?.(p.fraction),
    }),
  blockingPlans: (tourId, toHash) => savedPlans.blockingPlans(tourId, toHash),
  manifest: (tourId) => TourBundleRepository.readManifest(tourId),
};

export default function PlanPreviewScreen({ route, navigation }: PlanPreviewScreenProps) {
  const { planId, replanned = false } = route.params;
  const saved = useSavedPlans().find((p) => p.plan.plan_id === planId) ?? null;
  const [dl, setDl] = useState<Download>({ phase: 'idle' });
  // Bumped after a download so chapter titles are re-read from the new manifests.
  const [diskVersion, setDiskVersion] = useState(0);
  const [tourTitles, setTourTitles] = useState<ReadonlyMap<string, string>>(new Map());

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

  const rows = useMemo(() => {
    if (saved === null) return [];
    void diskVersion;
    return segmentRows(saved.plan, {
      chapterTitle: (tourId, chapterId) => TourBundleRepository.readManifest(tourId)?.chapters?.find((c) => c.chapter_id === chapterId)?.title ?? null,
      tourTitle: (tourId) => tourTitles.get(tourId) ?? TourBundleRepository.readManifest(tourId)?.tour_metadata.title ?? null,
    });
  }, [saved, tourTitles, diskVersion]);

  const replan = useCallback(async () => {
    if (saved === null) return;
    setDl({ phase: 'replanning' });
    const request = { ...saved.request, context: { local_time: localIsoWithOffset(new Date()) } };
    const result = await planClient.plan(request);
    if (!mounted.current) return;
    if (result.kind === 'error') {
      setDl({ phase: 'error', ...planErrorCopy(result) });
      return;
    }
    savedPlans.putDraft({ plan: result.plan, request, originLabel: saved.originLabel, savedAt: Date.now() });
    navigation.replace('PlanPreview', { planId: result.plan.plan_id, replanned: true });
  }, [saved, navigation]);

  const runDownload = useCallback(
    async (agreed: readonly string[]) => {
      if (saved === null) return;
      setDl({ phase: 'downloading', fraction: 0 });
      const outcome = await downloadPlanBundles(saved.plan, deps, {
        invalidatePlans: agreed,
        onProgress: (fraction) => mounted.current && setDl({ phase: 'downloading', fraction }),
        cancelled: () => !mounted.current,
      });
      if (mounted.current) setDiskVersion((v) => v + 1);

      if (outcome.kind === 'ready') {
        // Saved even if the visitor has left: the bundles are verified. Not if
        // the draft itself was replaced meanwhile (Back, then a new plan).
        if (savedPlans.get(planId) === null) {
          console.warn(`[PlanPreview] plan ${planId} was replaced while downloading; not saving it`);
          return;
        }
        savedPlans.markSaved(planId);
        if (mounted.current) setDl({ phase: 'idle' });
        return;
      }
      if (!mounted.current) return;

      switch (outcome.kind) {
        case 'conflict': {
          const copy = pinConflictCopy(outcome.blocking, 'new_plan');
          setDl({ phase: 'idle' });
          Alert.alert(copy.title, copy.message, [
            { text: 'Keep old plan', style: 'cancel' },
            { text: copy.confirm, style: 'destructive', onPress: () => void runDownload([...agreed, ...outcome.blocking.map((b) => b.planId)]) },
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
          setDl({ phase: 'error', title: 'Tours are being updated', message: 'This city\'s tours changed while we were planning. Please try again in a few minutes.' });
          return;
        case 'failed':
          setDl({ phase: 'error', title: 'Download failed', message: `${outcome.message} Finished parts are kept, so trying again continues where it stopped.` });
          return;
      }
    },
    [saved, planId, replanned, replan],
  );

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
    return (
      <View style={styles.centered}>
        <Text style={styles.h2}>This plan is gone</Text>
        <Text style={styles.muted}>It was deleted, or replaced when one of its tours was updated.</Text>
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
    runningTourId !== null && plan.sources.some((s) => s.tour_id === runningTourId && deps.localHash(s.tour_id) !== s.bundle_version_hash);
  const busy = dl.phase === 'downloading' || dl.phase === 'replanning';

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
            onPress={() => void runDownload([])}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy || blockedByRunningTour, busy }}
          >
            {busy ? <ActivityIndicator color={colors.canvas} /> : <Text style={styles.primaryText}>{dl.phase === 'error' ? 'Try again' : 'Download & save plan'}</Text>}
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
