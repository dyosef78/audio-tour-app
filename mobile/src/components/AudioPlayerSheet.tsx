import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { navigate } from '../navigation/navigationRef';
import { tourSession } from '../session/TourSessionController';
import { useTourSession } from '../session/tourSessionStore';

/**
 * Screen 4 - the globally floating mini player (PRD v2.0.0).
 *
 * Rendered by RootNavigator as a sibling of the Navigator, so navigating
 * between screens never unmounts it. It reads the Zustand store directly and
 * navigates through the container ref, because navigation hooks are unavailable
 * outside a navigator.
 *
 * Deliberately a fixed bar, not a draggable sheet: gesture-driven sheets need
 * react-native-reanimated and react-native-gesture-handler, neither installed.
 * Tapping it returns to the tour.
 */
export default function AudioPlayerSheet({ routeName }: { routeName?: string }) {
  const insets = useSafeAreaInsets();

  const status = useTourSession((s) => s.status);
  const tourId = useTourSession((s) => s.tourId);
  const tourTitle = useTourSession((s) => s.tourTitle);
  const waypoints = useTourSession((s) => s.waypoints);
  const activeId = useTourSession((s) => s.activeWaypointId);

  // Hidden unless a tour is genuinely running, and never on the tour screen
  // itself - the map there is the player, and two would compete.
  if (status !== 'active' || !tourId) return null;
  if (routeName === 'ActiveTour') return null;

  const active = waypoints.find((w) => w.id === activeId);
  const playing = active !== undefined;

  return (
    <View style={[styles.host, { paddingBottom: insets.bottom }]} pointerEvents="box-none">
      <Pressable
        style={styles.bar}
        onPress={() => navigate('ActiveTour', { tourId })}
        accessibilityRole="button"
        accessibilityLabel={playing ? `Playing ${active.name}. Return to tour.` : 'Return to tour'}
      >
        <View style={[styles.dot, playing && styles.dotLive]} />
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>
            {playing ? active.name : (tourTitle ?? 'Tour in progress')}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {playing ? 'Now playing' : 'Walking to the next stop'}
          </Text>
        </View>
        <Pressable
          hitSlop={10}
          onPress={() => void tourSession.endSession()}
          accessibilityRole="button"
          accessibilityLabel="End tour"
        >
          <Text style={styles.end}>End</Text>
        </Pressable>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // box-none on the host so taps pass through everywhere except the bar itself.
  host: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12 },
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#1C1C1E', borderRadius: 14, paddingVertical: 12, paddingHorizontal: 16,
    marginBottom: 10,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#6E6E73' },
  dotLive: { backgroundColor: '#34C759' },
  text: { flex: 1 },
  title: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  sub: { color: '#AEAEB2', fontSize: 11, marginTop: 1 },
  end: { color: '#FF6B57', fontSize: 13, fontWeight: '700' },
});
