import { useEffect, useLayoutEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import TourMap from '../components/TourMap';
import { tourSession } from '../session/TourSessionController';
import { useTourSession } from '../session/tourSessionStore';
import type { ActiveTourScreenProps } from '../navigation/types';
import type { RouteSource } from '../routing/routeDecision';

const ROUTE_LABEL: Record<RouteSource, string> = {
  dynamic: 'Route updated for your stops',
  static: 'Offline route',
  straight: 'No route yet - stops joined directly',
};

/**
 * Screen 3 - Active Map & Geofencing Engine (PRD v2.0.0).
 *
 * A pure observer. It never starts or stops the GPS itself - it asks
 * TourSessionController to start (idempotently) and reads the store.
 * Unmounting does NOT end the tour: the session survives the user navigating
 * back to Discovery, where the floating player takes over.
 *
 * Narration controls live in AudioPlayerSheet (TASK-602), which RootNavigator
 * renders over every screen. That also means this screen subscribes to NO
 * playback fields: positionSeconds changes twice a second, and reading it here
 * used to re-render the whole map - every marker and zone - on each tick.
 * End Tour moved to the header to leave the bottom edge to the sheet.
 */
export default function ActiveTourScreen({ route, navigation }: ActiveTourScreenProps) {
  const { tourId } = route.params;

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
  const notificationsGranted = useTourSession((s) => s.notificationPermission);
  const completed = useTourSession((s) => s.completionPrompted);
  // `mapRoute`, not `route`: that name is the navigation prop above.
  const mapRoute = useTourSession((s) => s.route);
  const skippedCount = useTourSession((s) => s.skippedWaypointIds.length);

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

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable hitSlop={12} onPress={() => void endTour()} accessibilityRole="button">
          <Text style={styles.headerEnd}>End Tour</Text>
        </Pressable>
      ),
    });
  }, [navigation]);

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

  return (
    <View style={styles.container}>
      <TourMap
        waypoints={waypoints}
        route={mapRoute.points}
        routeSource={mapRoute.source}
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
          {/* Says which of the three routes is on screen, so a field tester can
              tell "live route" from "offline route" without reading logs. */}
          <Text style={styles.cardMeta}>
            {ROUTE_LABEL[mapRoute.source]}
            {skippedCount > 0
              ? ` · ${skippedCount} stop${skippedCount === 1 ? '' : 's'} hidden by your preferences`
              : ''}
          </Text>
        </View>

        {!bgGranted && (
          <Text style={styles.warn}>
            Background location not granted — narration only triggers while the app is open.
          </Text>
        )}

        {!notificationsGranted && (
          <Text style={styles.warn}>
            Notifications are off, so Android won’t show that the tour is tracking your location. The tour still runs; to see it, allow notifications for Audio Tour in Settings.
          </Text>
        )}

        <View style={styles.debugRow} pointerEvents="box-none">
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
          {debug && (
            <Text style={styles.debugHint} numberOfLines={2}>
              Tap a map pin to play that stop without walking to it.
            </Text>
          )}
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
  headerEnd: { color: '#93331F', fontSize: 15, fontWeight: '700' },
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
  debugRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  debugHint: {
    flex: 1, fontSize: 11, color: '#1C1C1E', backgroundColor: 'rgba(255,255,255,0.94)',
    paddingVertical: 7, paddingHorizontal: 11, borderRadius: 9, overflow: 'hidden',
  },
  zoneToggle: {
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.96)', elevation: 4,
  },
  zoneToggleOn: { backgroundColor: '#0C6C6A' },
  zoneToggleText: { fontSize: 12, fontWeight: '700', color: '#1C1C1E' },
  zoneToggleTextOn: { color: '#FFFFFF' },
  primary: { marginTop: 8, paddingVertical: 12, paddingHorizontal: 26, borderRadius: 8, backgroundColor: '#1C1C1E' },
  primaryText: { color: '#FFFFFF', fontWeight: '600' },
});
