import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import type { HandoffProvider } from '../handoff/handoffLinks';
import { tourSession } from '../session/TourSessionController';
import { useTourSession } from '../session/tourSessionStore';

const PROVIDER_LABEL: Record<HandoffProvider, string> = {
  google_maps: 'Google Maps',
  waze: 'Waze',
};

/**
 * The chapter panel (Epic 15, Slice 5) on the active tour screen.
 *
 *   Chapter N of M - its title
 *   Navigate with Google Maps / Waze   (a chapter with a handoff)
 *   I'm here - Start next chapter      (whenever a next chapter exists)
 *
 * The "start next" button is the PM's mandatory manual path: it is ALWAYS
 * offered, independent of arrival detection, so a car park far from the pin
 * (or a GPS that never settles) cannot strand the listener. Arrival only
 * highlights it. Before arrival a confirm guards against a stray tap from a
 * passenger seat - switching chapter is not undoable from the UI.
 *
 * Hidden for a single plain chapter: nothing to navigate, nothing to switch.
 */
export default function ChapterPanel() {
  const chapters = useTourSession((s) => s.chapters);
  const activeId = useTourSession((s) => s.activeChapterId);
  const arrivedIds = useTourSession((s) => s.arrivedChapterIds);
  const [opening, setOpening] = useState<HandoffProvider | null>(null);

  if (chapters.length === 0) return null;
  const index = chapters.findIndex((c) => c.id === activeId);
  if (index < 0) {
    // setChapters and setActiveChapter both come from the engine's validated
    // progress: a miss is a controller bug, not a state to paper over.
    throw new Error(`ChapterPanel: active chapter ${String(activeId)} is not among the tour's ${chapters.length} chapters`);
  }
  const chapter = chapters[index];
  const next = chapters[index + 1] ?? null;
  if (chapters.length === 1 && chapter.handoff === null) return null;
  const arrived = arrivedIds.includes(chapter.id);

  const openUrl = (url: string): void => {
    tourSession.openHandoffUrl(url).catch((err: unknown) => {
      console.error('[ChapterPanel] could not open', url, err);
      Alert.alert('Could not open the link', err instanceof Error ? err.message : String(err));
    });
  };

  const navigate = async (provider: HandoffProvider): Promise<void> => {
    setOpening(provider);
    try {
      const plan = await tourSession.navigateWith(provider);
      if (plan?.kind === 'needs_app') {
        // Never silently drop the scenic route (handoffLinks: the browser trap).
        Alert.alert(
          'Google Maps app needed',
          `This chapter's route passes ${plan.anchorCount} scenic points. Google Maps in a browser follows only 3, so it would take a different road.`,
          [
            { text: 'Install Google Maps', onPress: () => openUrl(plan.installUrl) },
            { text: 'Go without the scenic route', onPress: () => openUrl(plan.withoutScenicUrl) },
            { text: 'Cancel', style: 'cancel' },
          ],
        );
      }
    } catch (err) {
      console.error(`[ChapterPanel] navigation with ${provider} failed:`, err);
      Alert.alert('Could not start navigation', err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(null);
    }
  };

  const startNext = (): void => {
    try {
      tourSession.startNextChapter();
    } catch (err) {
      console.error('[ChapterPanel] start next chapter failed:', err);
      Alert.alert('Could not start the next chapter', err instanceof Error ? err.message : String(err));
    }
  };

  const onStartNext = (): void => {
    if (arrived || next === null) return startNext();
    const where = chapter.handoff?.destinationLabel;
    Alert.alert(
      `Start "${next.title}"?`,
      where ? `You haven't reached ${where} yet. Start the next chapter anyway?` : 'Start the next chapter now?',
      [
        { text: 'Not yet', style: 'cancel' },
        { text: 'Start', onPress: startNext },
      ],
    );
  };

  return (
    <View style={styles.panel}>
      <Text style={styles.kicker}>
        Chapter {index + 1} of {chapters.length}
        {next === null ? ' · final chapter' : ''}
      </Text>
      <Text style={styles.title} numberOfLines={2}>
        {chapter.title}
      </Text>

      {chapter.handoff !== null && (
        <View style={styles.handoff}>
          <Text style={styles.meta} numberOfLines={2}>
            {chapter.handoff.destinationLabel ? `To ${chapter.handoff.destinationLabel}` : 'To the next starting point'}
            {chapter.handoff.anchorCount > 0
              ? ` · scenic route via ${chapter.handoff.anchorCount} point${chapter.handoff.anchorCount === 1 ? '' : 's'}`
              : ''}
          </Text>
          <View style={styles.providers}>
            {chapter.handoff.providers.map((p) => (
              <Pressable
                key={p}
                style={[styles.navigate, opening !== null && styles.disabled]}
                disabled={opening !== null}
                onPress={() => void navigate(p)}
                accessibilityRole="button"
                accessibilityLabel={`Navigate with ${PROVIDER_LABEL[p]}`}
              >
                <Text style={styles.navigateText}>{opening === p ? 'Opening…' : `Navigate · ${PROVIDER_LABEL[p]}`}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {next !== null && (
        <Pressable
          style={[styles.next, arrived && styles.nextArrived]}
          onPress={onStartNext}
          accessibilityRole="button"
          accessibilityLabel={`I'm here. Start next chapter: ${next.title}`}
        >
          {arrived && <Text style={styles.arrivedText}>You've arrived</Text>}
          <Text style={styles.nextText}>I'm here – Start next chapter</Text>
          <Text style={styles.nextSub} numberOfLines={1}>
            {next.title}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: 'rgba(255,255,255,0.97)', borderRadius: 12, padding: 14, gap: 6,
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 5,
  },
  kicker: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', opacity: 0.55 },
  title: { fontSize: 16, fontWeight: '700' },
  handoff: { gap: 8, marginTop: 2 },
  meta: { fontSize: 12, opacity: 0.7 },
  providers: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  navigate: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, backgroundColor: '#1C1C1E' },
  navigateText: { color: '#FFFFFF', fontWeight: '600', fontSize: 14 },
  disabled: { opacity: 0.5 },
  // Prominent by design (PM): full width, tall, the biggest target on screen.
  next: {
    marginTop: 6, minHeight: 64, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#0C6C6A',
  },
  nextArrived: { backgroundColor: '#0A8F4E', borderWidth: 3, borderColor: '#B9F5D3' },
  arrivedText: { color: '#E6FFF1', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  nextText: { color: '#FFFFFF', fontSize: 17, fontWeight: '800' },
  nextSub: { color: '#FFFFFF', fontSize: 13, opacity: 0.85, marginTop: 2 },
});
