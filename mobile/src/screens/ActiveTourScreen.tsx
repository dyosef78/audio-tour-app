import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import TourMap from '../components/TourMap';
import { tourSession } from '../session/TourSessionController';
import { useTourSession } from '../session/tourSessionStore';
import type { ActiveTourScreenProps } from '../navigation/types';

/** mm:ss, tolerant of the 0 the player reports before it has loaded. */
function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Screen 3 - Active Map & Geofencing Engine (PRD v2.0.0).
 *
 * A pure observer. It never starts or stops the GPS itself - it asks
 * TourSessionController to start (idempotently) and reads the store.
 * Unmounting does NOT end the tour: the session survives the user navigating
 * back to Discovery, where the floating player takes over.
 */
export default function ActiveTourScreen({ route, navigation }: ActiveTourScreenProps) {
  const { tourId } = route.params;
  const insets = useSafeAreaInsets();

  // Debug overlay defaults on in development. Kept as a toggle rather than a
  // build-time flag so geofence behaviour can be checked in the field, which is
  // the only place it actually misbehaves.
  const [debug, setDebug] = useState(__DEV__);

  const status = useTourSession((s) => s.status);
  const error = useTourSession((s) => s.error);
  const title = useTourSession((s) => s.tourTitle);
  const waypoints = useTourSession((s) => s.waypoints);
  const fix = useTourSession((s) => s.currentFix);
  const accuracy = useTourSession((s) => s.accuracyMeters);
  const tier = useTourSession((s) => s.samplingTier);
  const activeId = useTourSession((s) => s.activeWaypointId);
  const visited = useTourSession((s) => s.visitedWaypointIds);
  const bgGranted = useTourSession((s) => s.backgroundPermission);
  const completed = useTourSession((s) => s.completionPrompted);
  const isPlaying = useTourSession((s) => s.isPlaying);
  const position = useTourSession((s) => s.positionSeconds);
  const duration = useTourSession((s) => s.durationSeconds);
  const playbackError = useTourSession((s) => s.playbackError);

  // Requests a start; a no-op if this tour is already running. Safe under
  // StrictMode's mount/unmount/remount precisely because it is idempotent.
  useEffect(() => {
    void tourSession.startSession(tourId, title ?? 'Tour');
    // Intentionally no cleanup - unmounting a screen must not end the session.
  }, [tourId, title]);

  const endTour = async (): Promise<void> => {
    await tourSession.endSession();
    navigation.navigate('Discovery');
  };

  // Reaching the last stop prompts but never tears down, per the PM decision.
  useEffect(() => {
    if (!completed) return;
    Alert.alert('Tour completed', 'You have reached every stop. End the tour?', [
      {
        text: 'Keep exploring',
        style: 'cancel',
        onPress: () => useTourSession.getState().dismissCompletionPrompt(),
      },
      { text: 'End tour', style: 'destructive', onPress: () => void endTour() },
    ]);
  }, [completed]);

  if (status === 'starting' || status === 'idle') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
        <Text style={styles.muted}>Starting tour…</Text>
      </View>
    );
  }

  if (status === 'error') {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorTitle}>Could not start the tour</Text>
        <Text style={styles.muted}>{error}</Text>
        <Pressable style={styles.primary} onPress={() => navigation.goBack()}>
          <Text style={styles.primaryText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  const activeWaypoint = waypoints.find((w) => w.id === activeId);
  // Prefer the player's reported duration; fall back to the database value
  // until the first status update arrives, so the bar is never blank.
  const total = duration > 0 ? duration : (activeWaypoint?.audio?.durationSeconds ?? 0);
  const progress = total > 0 ? Math.min(position / total, 1) : 0;

  return (
    <View style={styles.container}>
      <TourMap
        waypoints={waypoints}
        currentFix={fix}
        activeWaypointId={activeId}
        visitedWaypointIds={visited}
        showZones={debug}
        onWaypointPress={debug ? (id) => void tourSession.triggerWaypoint(id) : undefined}
      />

      <View style={styles.topOverlay} pointerEvents="box-none">
        <View style={styles.card}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {activeWaypoint?.name ?? (fix ? 'Walking to the next stop' : 'Waiting for GPS…')}
          </Text>
          <Text style={styles.cardMeta}>
            {visited.length}/{waypoints.length} stops
            {accuracy !== null ? ` · ±${Math.round(accuracy)} m` : ''}
            {` · ${tier === 'fine' ? 'high accuracy' : 'power saving'}`}
          </Text>
        </View>

        {!bgGranted && (
          <Text style={styles.warn}>
            Background location not granted — narration only triggers while the app is open.
          </Text>
        )}
      </View>

      {/* One absolutely-positioned bottom stack: player above the controls, so
          the two never overlap and both clear the home indicator. */}
      <View style={[styles.bottomStack, { paddingBottom: insets.bottom + 12 }]} pointerEvents="box-none">
        {activeWaypoint && (
          <View style={styles.player}>
          <Pressable
            style={styles.transport}
            onPress={() => tourSession.togglePlayPause()}
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? 'Pause narration' : 'Play narration'}
          >
            <Text style={styles.transportGlyph}>{isPlaying ? '❚❚' : '▶'}</Text>
          </Pressable>

          <View style={styles.playerBody}>
            <Text style={styles.playerTitle} numberOfLines={1}>{activeWaypoint.name}</Text>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
            </View>
            {playbackError ? (
              <Text style={styles.playerError} numberOfLines={3}>{playbackError}</Text>
            ) : (
            <Text style={styles.playerMeta}>
              {fmtTime(position)} / {fmtTime(total)}
              {isPlaying ? '' : ' · paused'}
            </Text>
            )}
          </View>

          <Pressable
            hitSlop={10}
            onPress={() => void tourSession.releaseWaypoint(activeWaypoint.id)}
            accessibilityRole="button"
            accessibilityLabel="Stop narration"
          >
              <Text style={styles.playerStop}>Stop</Text>
            </Pressable>
          </View>
        )}

        {debug && (
          <Text style={styles.debugHint}>
            Debug mode: tap a map pin to play that stop without walking to it.
          </Text>
        )}

        <View style={styles.controls} pointerEvents="box-none">
          <Pressable
            style={[styles.zoneToggle, debug && styles.zoneToggleOn]}
            onPress={() => setDebug((v) => !v)}
            accessibilityRole="switch"
            accessibilityState={{ checked: debug }}
          >
            <Text style={[styles.zoneToggleText, debug && styles.zoneToggleTextOn]}>
              {debug ? 'Debug on' : 'Debug off'}
            </Text>
          </Pressable>

          <Pressable style={styles.end} onPress={() => void endTour()}>
            <Text style={styles.endText}>End Tour</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  muted: { fontSize: 14, opacity: 0.6, textAlign: 'center', lineHeight: 20 },
  errorTitle: { fontSize: 17, fontWeight: '600' },
  topOverlay: { position: 'absolute', top: 12, left: 12, right: 12, gap: 8 },
  card: {
    backgroundColor: 'rgba(255,255,255,0.96)', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14,
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 5,
  },
  cardTitle: { fontSize: 15, fontWeight: '700' },
  cardMeta: { fontSize: 12, opacity: 0.65, marginTop: 2, fontVariant: ['tabular-nums'] },
  warn: {
    fontSize: 11, color: '#8A5A00', backgroundColor: 'rgba(251,240,224,0.96)',
    padding: 9, borderRadius: 9, overflow: 'hidden',
  },
  bottomStack: { position: 'absolute', left: 12, right: 12, bottom: 0, gap: 10 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 10 },

  // --- in-screen media player -------------------------------------------------
  player: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: 'rgba(28,28,30,0.96)', borderRadius: 14,
    paddingVertical: 12, paddingHorizontal: 14,
    shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  transport: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: '#FFFFFF',
    alignItems: 'center', justifyContent: 'center',
  },
  transportGlyph: { fontSize: 15, color: '#1C1C1E', fontWeight: '700' },
  playerBody: { flex: 1, gap: 5 },
  playerTitle: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  progressTrack: { height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.22)', overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: '#34C759' },
  playerMeta: { color: '#AEAEB2', fontSize: 11, fontVariant: ['tabular-nums'] },
  playerError: { color: '#FF9F8A', fontSize: 11, lineHeight: 15 },
  playerStop: { color: '#FF6B57', fontSize: 13, fontWeight: '700' },
  debugHint: {
    fontSize: 11, color: '#1C1C1E', backgroundColor: 'rgba(255,255,255,0.94)',
    paddingVertical: 7, paddingHorizontal: 11, borderRadius: 9, overflow: 'hidden', textAlign: 'center',
  },
  zoneToggle: {
    paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.96)', elevation: 4,
  },
  zoneToggleOn: { backgroundColor: '#0C6C6A' },
  zoneToggleText: { fontSize: 12, fontWeight: '700', color: '#1C1C1E' },
  zoneToggleTextOn: { color: '#FFFFFF' },
  end: {
    flex: 1, paddingVertical: 14, borderRadius: 10, backgroundColor: '#93331F',
    alignItems: 'center', elevation: 4,
  },
  endText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  primary: { marginTop: 8, paddingVertical: 12, paddingHorizontal: 26, borderRadius: 8, backgroundColor: '#1C1C1E' },
  primaryText: { color: '#FFFFFF', fontWeight: '600' },
});
