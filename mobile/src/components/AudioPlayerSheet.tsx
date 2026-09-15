import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { navigate } from '../navigation/navigationRef';
import { tourSession } from '../session/TourSessionController';
import { useTourSession } from '../session/tourSessionStore';
import type { Waypoint } from '../types/domain';
import { colors, MIN_TOUCH } from '../ui/theme';
import { useReduceMotion } from '../ui/useReduceMotion';
import TranscriptView from './player/TranscriptView';

/** Handle strip + header row + progress line: the part visible when collapsed. */
const HANDLE_HEIGHT = 22;
const HEADER_ROW_HEIGHT = 60;
const PROGRESS_HEIGHT = 10;
const PEEK_HEIGHT = HANDLE_HEIGHT + HEADER_ROW_HEIGHT + PROGRESS_HEIGHT;

const EXPANDED_FRACTION = 0.82;
const REWIND_SECONDS = 15;

/** mm:ss, tolerant of the 0 the player reports before it has loaded. */
function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Screen 4 - Smart Audio Player (PRD v2.0.0), as a bottom sheet (TASK-602).
 *
 * Rendered by RootNavigator as a sibling of the Navigator, so navigating never
 * unmounts it. It reads the Zustand store directly and navigates through the
 * container ref, because navigation hooks are unavailable outside a navigator.
 *
 * Now the ONLY transport in the app - ActiveTourScreen's inline player was
 * folded into it, so there is one set of controls to keep honest.
 *
 * Built on core Animated + PanResponder, NOT reanimated/gesture-handler. Both
 * are native modules and would force a new dev-client build for every tester;
 * see the handover for when that trade stops being worth it. The drag is
 * confined to the header so the transcript keeps its own scrolling, and
 * every drag has a tap and a screen-reader equivalent.
 */
export default function AudioPlayerSheet({ routeName }: { routeName?: string }) {
  const status = useTourSession((s) => s.status);
  const tourId = useTourSession((s) => s.tourId);
  const tourTitle = useTourSession((s) => s.tourTitle);
  const waypoints = useTourSession((s) => s.waypoints);
  const activeId = useTourSession((s) => s.activeWaypointId);

  if (status !== 'active' || !tourId) return null;
  // The onboarding footer button sits exactly where the sheet would.
  if (routeName?.startsWith('Onboarding')) return null;

  const activeIndex = waypoints.findIndex((w) => w.id === activeId);
  const active = waypoints[activeIndex];
  const onTourScreen = routeName === 'ActiveTour';

  if (!active) {
    // Between stops the map's own card says "walking"; elsewhere, a way back.
    return onTourScreen ? null : <ReturnToTourBar tourId={tourId} tourTitle={tourTitle} />;
  }

  return (
    <NowPlayingSheet
      tourId={tourId}
      waypoint={active}
      stopNumber={activeIndex + 1}
      stopCount={waypoints.length}
      onTourScreen={onTourScreen}
    />
  );
}

// -----------------------------------------------------------------------------
// Between stops, away from the map
// -----------------------------------------------------------------------------

function ReturnToTourBar({ tourId, tourTitle }: { tourId: string; tourTitle: string | null }) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.barHost, { paddingBottom: insets.bottom }]} pointerEvents="box-none">
      <Pressable
        style={styles.bar}
        onPress={() => navigate('ActiveTour', { tourId })}
        accessibilityRole="button"
        accessibilityLabel="Return to tour"
      >
        <View style={styles.dot} />
        <View style={styles.flex}>
          <Text style={styles.barTitle} numberOfLines={1}>{tourTitle ?? 'Tour in progress'}</Text>
          <Text style={styles.barSub} numberOfLines={1}>Walking to the next stop</Text>
        </View>
        <Pressable
          hitSlop={10}
          onPress={() => void tourSession.endSession()}
          accessibilityRole="button"
          accessibilityLabel="End tour"
        >
          <Text style={styles.barEnd}>End</Text>
        </Pressable>
      </Pressable>
    </View>
  );
}

// -----------------------------------------------------------------------------
// Narrating
// -----------------------------------------------------------------------------

function NowPlayingSheet({
  tourId,
  waypoint,
  stopNumber,
  stopCount,
  onTourScreen,
}: {
  tourId: string;
  waypoint: Waypoint;
  stopNumber: number;
  stopCount: number;
  onTourScreen: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const reduceMotion = useReduceMotion();

  const isPlaying = useTourSession((s) => s.isPlaying);
  const deepDiveActive = useTourSession((s) => s.deepDiveWaypointId === waypoint.id);

  const track = deepDiveActive ? (waypoint.deepDive ?? null) : waypoint.audio;

  const collapsedHeight = PEEK_HEIGHT + insets.bottom;
  const expandedHeight = Math.max(collapsedHeight, Math.round(windowHeight * EXPANDED_FRACTION));
  // How far the sheet slides. translateY runs from `travel` (collapsed) to 0.
  const travel = expandedHeight - collapsedHeight;

  const [expanded, setExpanded] = useState(false);
  const expandedRef = useRef(false);
  const translateY = useRef(new Animated.Value(travel)).current;

  const snapTo = useCallback(
    (expand: boolean) => {
      expandedRef.current = expand;
      setExpanded(expand);
      const toValue = expand ? 0 : travel;
      if (reduceMotion) {
        translateY.setValue(toValue);
        return;
      }
      Animated.spring(translateY, {
        toValue,
        useNativeDriver: true,
        damping: 24,
        stiffness: 240,
        mass: 0.9,
      }).start();
    },
    [reduceMotion, translateY, travel],
  );

  // Rotation or split-screen changes the travel; re-seat without animating.
  useEffect(() => {
    translateY.setValue(expandedRef.current ? 0 : travel);
  }, [translateY, travel]);

  // Android back collapses the sheet before it navigates anywhere.
  useEffect(() => {
    if (!expanded) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      snapTo(false);
      return true;
    });
    return () => sub.remove();
  }, [expanded, snapTo]);

  const pan = useMemo(() => {
    // Where the drag began. Taken from the settled state rather than the live
    // animated value: reading that back from the native driver is async, and a
    // grab mid-spring is rare enough that a small jump beats a stale read.
    let origin = travel;
    return PanResponder.create({
      // Claim only a clearly vertical move, so taps still reach the buttons.
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderGrant: () => {
        translateY.stopAnimation();
        origin = expandedRef.current ? 0 : travel;
      },
      onPanResponderMove: (_e, g) => translateY.setValue(clamp(origin + g.dy, 0, travel)),
      onPanResponderRelease: (_e, g) => {
        const at = clamp(origin + g.dy, 0, travel);
        // A flick decides by direction; a slow drag by which half it ended in.
        snapTo(g.vy < -0.4 ? true : g.vy > 0.4 ? false : at < travel / 2);
      },
      onPanResponderTerminate: () => snapTo(expandedRef.current),
    });
  }, [snapTo, translateY, travel]);

  // The body fades with the drag, so the sliver under the home indicator is
  // blank when collapsed rather than showing the top of the controls.
  const bodyOpacity = translateY.interpolate({
    inputRange: [0, Math.max(1, travel)],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  const toggle = (): void => snapTo(!expanded);

  return (
    <Animated.View style={[styles.sheet, { height: expandedHeight, transform: [{ translateY }] }]}>
      <View {...pan.panHandlers}>
        <Pressable
          style={styles.handleHit}
          onPress={toggle}
          accessibilityRole="button"
          accessibilityLabel={expanded ? 'Collapse player' : 'Expand player and transcript'}
          accessibilityState={{ expanded }}
        >
          <View style={styles.handle} />
        </Pressable>

        <View style={styles.headerRow}>
          <Pressable
            style={styles.play}
            onPress={() => tourSession.togglePlayPause()}
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? 'Pause narration' : 'Play narration'}
          >
            <Text style={styles.playGlyph}>{isPlaying ? '❚❚' : '▶'}</Text>
          </Pressable>

          <Pressable
            style={styles.flex}
            onPress={toggle}
            accessibilityRole="button"
            accessibilityLabel={`${deepDiveActive ? 'Deep Dive: ' : ''}${waypoint.name}`}
            accessibilityHint={expanded ? 'Collapses the player' : 'Shows controls and the transcript'}
            accessibilityState={{ expanded }}
          >
            <Text style={[styles.eyebrow, deepDiveActive && styles.eyebrowDeep]} numberOfLines={1}>
              {deepDiveActive ? 'DEEP DIVE' : `STOP ${stopNumber} OF ${stopCount}`}
            </Text>
            <Text style={styles.title} numberOfLines={1}>{waypoint.name}</Text>
          </Pressable>

          {/* Duplicates the title's action at a glance; hidden from screen readers. */}
          <Pressable
            style={styles.chevronHit}
            onPress={toggle}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Text style={styles.chevron}>{expanded ? '⌄' : '⌃'}</Text>
          </Pressable>
        </View>

        <ProgressLine fallbackDuration={track?.durationSeconds ?? null} />
      </View>

      <Animated.View
        style={[styles.body, { opacity: bodyOpacity, paddingBottom: insets.bottom + 8 }]}
        pointerEvents={expanded ? 'auto' : 'none'}
        accessibilityElementsHidden={!expanded}
        importantForAccessibility={expanded ? 'auto' : 'no-hide-descendants'}
      >
        <TimeReadout fallbackDuration={track?.durationSeconds ?? null} />

        <View style={styles.controls}>
          <ControlButton
            label={`↺ ${REWIND_SECONDS}s`}
            accessibilityLabel={`Rewind ${REWIND_SECONDS} seconds`}
            onPress={() => void tourSession.rewind(REWIND_SECONDS)}
          />
          {!onTourScreen && (
            <ControlButton
              label="Map"
              accessibilityLabel="Open the tour map"
              onPress={() => {
                snapTo(false);
                navigate('ActiveTour', { tourId });
              }}
            />
          )}
          <ControlButton
            label="Stop"
            tone="danger"
            accessibilityLabel="Stop narration"
            onPress={() => {
              snapTo(false);
              void tourSession.releaseWaypoint(waypoint.id);
            }}
          />
        </View>

        {waypoint.poiType !== 'transition' && <DeepDiveButton waypoint={waypoint} active={deepDiveActive} />}

        <Text style={styles.sectionLabel} accessibilityRole="header">Transcript</Text>
        <View style={styles.transcript}>
          {/* Mounted only while expanded: collapsed, it would re-render off-screen
              on every highlight change for nobody. */}
          {expanded && track && (
            <TranscriptView
              tourId={tourId}
              track={track}
              reduceMotion={reduceMotion}
              onSeek={(seconds) => void tourSession.seekTo(seconds)}
            />
          )}
        </View>
      </Animated.View>
    </Animated.View>
  );
}

// -----------------------------------------------------------------------------
// Position-driven leaves. Isolated so a 2 Hz status tick re-renders these, not the sheet.
// -----------------------------------------------------------------------------

function usePlaybackTotal(fallbackDuration: number | null): { position: number; total: number } {
  const position = useTourSession((s) => s.positionSeconds);
  const duration = useTourSession((s) => s.durationSeconds);
  // Prefer the player's reported duration; fall back to the database value
  // until the first status update arrives, so the bar is never blank.
  return { position, total: duration > 0 ? duration : (fallbackDuration ?? 0) };
}

function ProgressLine({ fallbackDuration }: { fallbackDuration: number | null }) {
  const { position, total } = usePlaybackTotal(fallbackDuration);
  const progress = total > 0 ? Math.min(position / total, 1) : 0;

  return (
    <View style={styles.progressHost}>
      <View
        style={styles.progressTrack}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: Math.round(total), now: Math.round(position), text: `${fmtTime(position)} of ${fmtTime(total)}` }}
      >
        <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
      </View>
    </View>
  );
}

function TimeReadout({ fallbackDuration }: { fallbackDuration: number | null }) {
  const { position, total } = usePlaybackTotal(fallbackDuration);
  const isPlaying = useTourSession((s) => s.isPlaying);
  const playbackError = useTourSession((s) => s.playbackError);

  if (playbackError) {
    return <Text style={styles.error} numberOfLines={3}>{playbackError}</Text>;
  }
  return (
    <Text style={styles.time}>
      {fmtTime(position)} / {fmtTime(total)}
      {isPlaying ? '' : ' · paused'}
    </Text>
  );
}

function ControlButton({
  label,
  accessibilityLabel,
  onPress,
  tone = 'default',
}: {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  tone?: 'default' | 'danger';
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.control, pressed && styles.pressed]}
    >
      <Text style={[styles.controlText, tone === 'danger' && styles.controlDanger]}>{label}</Text>
    </Pressable>
  );
}

/**
 * Always visible on an anchor stop, per the brief - disabled with a reason
 * when the downloaded bundle holds no Deep Dive for the stop.
 */
function DeepDiveButton({ waypoint, active }: { waypoint: Waypoint; active: boolean }) {
  if (active) {
    return (
      <Pressable
        style={({ pressed }) => [styles.deepDive, styles.deepDiveActive, pressed && styles.pressed]}
        onPress={() => void tourSession.playNarration(waypoint.id)}
        accessibilityRole="button"
        accessibilityLabel="Leave the Deep Dive and replay this stop's narration"
      >
        <Text style={styles.deepDiveIcon}>🎧</Text>
        <View style={styles.flex}>
          <Text style={styles.deepDiveTitle}>Playing Deep Dive</Text>
          <Text style={styles.deepDiveSub}>Tap to return to the stop narration</Text>
        </View>
      </Pressable>
    );
  }

  const deepDive = waypoint.deepDive ?? null;
  const available = deepDive?.localUri !== undefined;
  const minutes =
    deepDive?.durationSeconds != null && deepDive.durationSeconds > 0
      ? Math.max(1, Math.round(deepDive.durationSeconds / 60))
      : null;

  return (
    <Pressable
      disabled={!available}
      onPress={() => void tourSession.playDeepDive(waypoint.id)}
      accessibilityRole="button"
      accessibilityState={{ disabled: !available }}
      accessibilityLabel={
        available
          ? `Deep Dive${minutes ? `, ${minutes} minutes` : ''}. Extended story about ${waypoint.name}`
          : 'Deep Dive. Not available for this stop yet'
      }
      style={({ pressed }) => [styles.deepDive, !available && styles.deepDiveOff, pressed && styles.pressed]}
    >
      <Text style={styles.deepDiveIcon}>🎧</Text>
      <View style={styles.flex}>
        <Text style={[styles.deepDiveTitle, !available && styles.deepDiveTitleOff]}>
          Deep Dive{minutes ? ` · ${minutes} min` : ''}
        </Text>
        <Text style={styles.deepDiveSub}>
          {available ? 'The extended story of this stop' : 'Not available for this stop yet'}
        </Text>
      </View>
      {available && <Text style={styles.deepDiveArrow}>›</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pressed: { opacity: 0.7 },

  // --- between stops -----------------------------------------------------------
  // box-none on the host so taps pass through everywhere except the bar itself.
  barHost: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12 },
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.sheet, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 16,
    marginBottom: 10,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.onSheetFaint },
  barTitle: { color: colors.onSheet, fontSize: 14, fontWeight: '600' },
  barSub: { color: colors.onSheetMuted, fontSize: 11, marginTop: 1 },
  barEnd: { color: colors.danger, fontSize: 13, fontWeight: '700' },

  // --- sheet -------------------------------------------------------------------
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: colors.sheet,
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 18, shadowOffset: { width: 0, height: -4 },
    elevation: 16,
  },
  handleHit: { height: HANDLE_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  handle: { width: 40, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.3)' },

  headerRow: { height: HEADER_ROW_HEIGHT, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 },
  play: {
    width: 48, height: 48, borderRadius: 24, backgroundColor: colors.onSheet,
    alignItems: 'center', justifyContent: 'center',
  },
  playGlyph: { fontSize: 16, color: colors.sheet, fontWeight: '800' },
  eyebrow: { color: colors.onSheetMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  eyebrowDeep: { color: '#FFD60A' },
  title: { color: colors.onSheet, fontSize: 17, fontWeight: '700', marginTop: 2 },
  chevronHit: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  chevron: { color: colors.onSheetMuted, fontSize: 22, fontWeight: '700' },

  progressHost: { height: PROGRESS_HEIGHT, paddingHorizontal: 16, justifyContent: 'flex-start' },
  progressTrack: { height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)', overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: colors.live },

  body: { flex: 1, paddingHorizontal: 16, paddingTop: 4 },
  time: { color: colors.onSheetMuted, fontSize: 13, fontVariant: ['tabular-nums'] },
  error: { color: colors.sheetError, fontSize: 13, lineHeight: 18 },

  controls: { flexDirection: 'row', gap: 10, marginTop: 14 },
  control: {
    flex: 1, minHeight: MIN_TOUCH, borderRadius: 12, backgroundColor: colors.sheetRaised,
    alignItems: 'center', justifyContent: 'center',
  },
  controlText: { color: colors.onSheet, fontSize: 15, fontWeight: '700' },
  controlDanger: { color: colors.danger },

  deepDive: {
    flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12,
    minHeight: 60, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14,
    backgroundColor: colors.accent,
  },
  deepDiveActive: { backgroundColor: '#5E4B00' },
  deepDiveOff: { backgroundColor: colors.sheetRaised },
  deepDiveIcon: { fontSize: 22 },
  deepDiveTitle: { color: colors.onSheet, fontSize: 15, fontWeight: '700' },
  deepDiveTitleOff: { color: colors.onSheetMuted },
  deepDiveSub: { color: colors.onSheetMuted, fontSize: 12, marginTop: 1 },
  deepDiveArrow: { color: colors.onSheet, fontSize: 24, fontWeight: '600' },

  sectionLabel: {
    color: colors.onSheetMuted, fontSize: 12, fontWeight: '700', letterSpacing: 0.8,
    textTransform: 'uppercase', marginTop: 18, marginBottom: 6,
  },
  transcript: { flex: 1 },
});
