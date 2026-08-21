import { useEffect } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { tourSession } from '../session/TourSessionController';
import { useTourSession } from '../session/tourSessionStore';
import type { ActiveTourScreenProps } from '../navigation/types';

/**
 * Screen 3 - Active Tour (PRD v2.0.0). The TASK-202 handoff.
 *
 * A pure observer. It never starts or stops the GPS itself - it asks
 * TourSessionController to start (idempotently) and reads the store.
 * Unmounting this screen does NOT end the tour: the session must survive the
 * user navigating back to Discovery while audio keeps playing.
 *
 * MapView is deliberately not mounted yet. react-native-maps needs a real
 * Google Maps API key on Android and app.json still carries the placeholder -
 * a blank grey rectangle would look finished while being useless. The route
 * polyline, POI markers and geofence overlay are TASK-102.
 */
export default function ActiveTourScreen({ route, navigation }: ActiveTourScreenProps) {
  const { tourId } = route.params;

  // Selector subscriptions: a 2 Hz GPS fix re-renders the status bar without
  // re-rendering the waypoint list.
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

  return (
    <View style={styles.container}>
      <View style={styles.statusBar}>
        <Text style={styles.statusText}>
          {fix ? `${fix.latitude.toFixed(5)}, ${fix.longitude.toFixed(5)}` : 'Waiting for GPS…'}
        </Text>
        <Text style={styles.statusMeta}>
          {accuracy !== null ? `±${Math.round(accuracy)} m · ` : ''}
          {tier === 'fine' ? 'high accuracy' : 'power saving'}
        </Text>
      </View>

      {!bgGranted && (
        <Text style={styles.warn}>
          Background location was not granted — narration will only trigger while the app is open.
        </Text>
      )}

      <ScrollView contentContainerStyle={styles.list}>
        {waypoints.map((w) => {
          const isActive = w.id === activeId;
          const isVisited = visited.includes(w.id);
          return (
            <View key={w.id} style={[styles.row, isActive && styles.rowActive]}>
              <Text style={styles.rowIndex}>{w.sortOrder}</Text>
              <View style={styles.rowBody}>
                <Text style={styles.rowName}>{w.name}</Text>
                <Text style={styles.rowMeta}>
                  {w.geofence
                    ? w.geofence.zoneType === 'radius'
                      ? `radius ${w.geofence.radiusMeters} m`
                      : 'polygon zone'
                    : 'no geofence'}
                  {w.audio?.durationSeconds ? ` · ${w.audio.durationSeconds}s` : ''}
                </Text>
              </View>
              <Text style={styles.rowState}>{isActive ? 'playing' : isVisited ? 'visited' : ''}</Text>
            </View>
          );
        })}
      </ScrollView>

      <Pressable style={styles.end} onPress={() => void endTour()}>
        <Text style={styles.endText}>End Tour</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  muted: { fontSize: 14, opacity: 0.6, textAlign: 'center', lineHeight: 20 },
  errorTitle: { fontSize: 17, fontWeight: '600' },
  statusBar: { padding: 12, borderRadius: 10, backgroundColor: '#EFEFF4', gap: 2 },
  statusText: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  statusMeta: { fontSize: 12, opacity: 0.6 },
  warn: { fontSize: 12, color: '#8A5A00', backgroundColor: '#FBF0E0', padding: 10, borderRadius: 8 },
  list: { gap: 8, paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: '#C7C7CC' },
  rowActive: { borderColor: '#1C1C1E', borderWidth: 2 },
  rowIndex: { fontSize: 13, opacity: 0.5, width: 16, fontVariant: ['tabular-nums'] },
  rowBody: { flex: 1, gap: 2 },
  rowName: { fontSize: 15, fontWeight: '600' },
  rowMeta: { fontSize: 12, opacity: 0.6 },
  rowState: { fontSize: 11, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.5 },
  primary: { marginTop: 8, paddingVertical: 12, paddingHorizontal: 26, borderRadius: 8, backgroundColor: '#1C1C1E' },
  primaryText: { color: '#FFFFFF', fontWeight: '600' },
  end: { paddingVertical: 14, borderRadius: 10, backgroundColor: '#93331F', alignItems: 'center' },
  endText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
});
