import { create } from 'zustand';

import type { RouteDisplay } from '../routing/routeDecision';
import type { LatLng, TransitMode, Waypoint } from '../types/domain';

/**
 * Tour session store - state only, no hardware.
 *
 * Deliberately an external store rather than Context: two of our three writers
 * are not React. Geofence events arrive through plain LocationService callbacks,
 * and the background TaskManager task runs in a JS context with no component
 * tree at all. Both can call `useTourSession.getState().<action>()` directly.
 *
 * Components subscribe with selectors so a 2 Hz GPS fix re-renders the map dot
 * without also re-rendering the player sheet.
 *
 * Nothing here touches expo-location or expo-audio. That belongs to
 * TourSessionController, which is the single owner of the hardware.
 */

export type SessionStatus = 'idle' | 'starting' | 'active' | 'error';

export interface TourSessionState {
  status: SessionStatus;
  tourId: string | null;
  tourTitle: string | null;
  transitMode: TransitMode | null;
  /**
   * The stops this session RUNS - after onboarding filtering (TASK-604) - in
   * the order they narrate: authored order, until a live route supplies its
   * own (TASK-902, setStopOrder).
   */
  waypoints: Waypoint[];
  /** Stops removed by the preferences: no pin, no geofence. */
  skippedWaypointIds: string[];
  /** What the map draws, maintained by RouteManager as connectivity changes. */
  route: RouteDisplay;

  /** Live position, for the map dot. Highest-frequency field in the store. */
  currentFix: LatLng | null;
  accuracyMeters: number | null;
  samplingTier: 'coarse' | 'fine';

  /** Live transport state, mirrored from the audio player itself. */
  isPlaying: boolean;
  positionSeconds: number;
  durationSeconds: number;

  /**
   * Last playback failure, shown on the transport.
   *
   * expo-audio has no error event, so a track that cannot be decoded otherwise
   * looks identical to one that has not started. This is what stops the UI
   * claiming "playing" at 0:00 forever.
   */
  playbackError: string | null;

  /** Waypoint currently narrating, if any. Drives the player sheet. */
  activeWaypointId: string | null;
  /**
   * The waypoint whose Deep Dive is playing instead of its narration (TASK-602).
   *
   * A Deep Dive is chosen, not triggered, and runs for minutes, so it survives a
   * zone exit - the listener has usually wandered on by the end. Entering a
   * DIFFERENT waypoint still displaces it; see markEntered.
   */
  deepDiveWaypointId: string | null;
  /** Waypoints whose geofence has been entered at least once. */
  visitedWaypointIds: string[];

  /**
   * All waypoints visited. Per the PM decision this only PROMPTS - it never
   * ends the session, so a user can linger at the last stop.
   */
  completionPrompted: boolean;

  /** Whether background location permission was granted, for honest UI. */
  backgroundPermission: boolean;
  /** Android 13+: false hides the tracking notice (the tour still runs). */
  notificationPermission: boolean;
  error: string | null;
}

export interface TourSessionActions {
  beginStart: (tourId: string, tourTitle: string) => void;
  sessionStarted: (args: {
    waypoints: Waypoint[];
    transitMode: TransitMode;
    backgroundPermission: boolean;
    notificationPermission?: boolean;
    skippedWaypointIds?: string[];
  }) => void;
  setRoute: (route: RouteDisplay) => void;
  /** Reorder `waypoints`. Ignored unless it names exactly the same stops. */
  setStopOrder: (waypointIds: readonly string[]) => void;
  sessionFailed: (message: string) => void;
  reset: () => void;

  setFix: (fix: LatLng, accuracyMeters: number | null) => void;
  setSamplingTier: (tier: 'coarse' | 'fine') => void;

  setPlaybackError: (message: string | null) => void;
  setPlayback: (snapshot: { isPlaying: boolean; positionSeconds: number; durationSeconds: number }) => void;
  markEntered: (waypointId: string) => void;
  /** Epic 13: the visited stops of a session resumed from its checkpoint. */
  restoreVisited: (waypointIds: readonly string[]) => void;
  markExited: (waypointId: string) => void;
  startDeepDive: (waypointId: string) => void;
  endDeepDive: () => void;
  dismissCompletionPrompt: () => void;
  /**
   * Epic 15: the engine's state, projected for the screens. The engine is the
   * source of truth; this replaces markEntered / markExited / startDeepDive /
   * endDeepDive for engine sessions.
   */
  applyEngineView: (view: EngineView) => void;
  /**
   * The stop whose card the player shows. Set when its narration or Deep Dive
   * goes on air; cleared only when the listener leaves it (walking zone exit)
   * or dismisses it - a finished narration keeps its card, with its Deep Dive
   * and replay buttons, as before Epic 15.
   */
  setOnAir: (waypointId: string | null, deepDive: boolean) => void;
  /** Raise the end-of-tour prompt once - on the transition to "every stop resolved". */
  promptCompletion: () => void;
}

/** What the screens need from the engine's state (EngineRunner publish). */
export interface EngineView {
  /** Stops whose narration actually started, in the order they did. */
  visitedWaypointIds: string[];
}

const initial: TourSessionState = {
  status: 'idle',
  tourId: null,
  tourTitle: null,
  transitMode: null,
  waypoints: [],
  skippedWaypointIds: [],
  route: { source: 'straight', points: null },
  currentFix: null,
  accuracyMeters: null,
  samplingTier: 'coarse',
  playbackError: null,
  isPlaying: false,
  positionSeconds: 0,
  durationSeconds: 0,
  activeWaypointId: null,
  deepDiveWaypointId: null,
  visitedWaypointIds: [],
  completionPrompted: false,
  backgroundPermission: false,
  notificationPermission: true,
  error: null,
};

export const useTourSession = create<TourSessionState & TourSessionActions>((set) => ({
  ...initial,

  beginStart: (tourId, tourTitle) =>
    set({ ...initial, status: 'starting', tourId, tourTitle }),

  sessionStarted: ({ waypoints, transitMode, backgroundPermission, notificationPermission = true, skippedWaypointIds = [] }) =>
    set({ status: 'active', waypoints, transitMode, backgroundPermission, notificationPermission, skippedWaypointIds, error: null }),

  setRoute: (route) => set({ route }),

  setStopOrder: (waypointIds) =>
    set((s) => {
      const byId = new Map(s.waypoints.map((w) => [w.id, w]));
      const ordered = waypointIds.map((id) => byId.get(id));
      if (ordered.length !== s.waypoints.length || new Set(waypointIds).size !== waypointIds.length) return {};
      if (!ordered.every((w): w is Waypoint => w !== undefined)) return {};
      return { waypoints: ordered };
    }),

  sessionFailed: (message) => set({ status: 'error', error: message }),

  reset: () => set({ ...initial }),

  setFix: (currentFix, accuracyMeters) => set({ currentFix, accuracyMeters }),

  setSamplingTier: (samplingTier) => set({ samplingTier }),

  setPlayback: ({ isPlaying, positionSeconds, durationSeconds }) =>
    set({ isPlaying, positionSeconds, durationSeconds }),

  setPlaybackError: (playbackError) =>
    // A failure always resets the transport too, so the UI can never sit at
    // "playing 0:00" with an error underneath it.
    set(
      playbackError === null
        ? { playbackError: null }
        : { playbackError, isPlaying: false, positionSeconds: 0, durationSeconds: 0 },
    ),

  restoreVisited: (waypointIds) =>
    set((s) => {
      const known = new Set(s.waypoints.map((w) => w.id));
      return { visitedWaypointIds: waypointIds.filter((id) => known.has(id)) };
    }),

  markEntered: (waypointId) =>
    set((s) => {
      const visited = s.visitedWaypointIds.includes(waypointId)
        ? s.visitedWaypointIds
        : [...s.visitedWaypointIds, waypointId];

      // Prompt once, when every waypoint has been reached. Latching on
      // `completionPrompted` keeps a re-entry from re-prompting.
      const allVisited = s.waypoints.length > 0 && visited.length >= s.waypoints.length;

      return {
        activeWaypointId: waypointId,
        visitedWaypointIds: visited,
        completionPrompted: s.completionPrompted || allVisited,
        // A new stop clears the previous stop's failure.
        playbackError: null,
        // Re-entering the same stop keeps its Deep Dive; a new stop's narration
        // displaces it (PM to confirm - see the TASK-602 handover).
        deepDiveWaypointId: s.deepDiveWaypointId === waypointId ? s.deepDiveWaypointId : null,
      };
    }),

  markExited: (waypointId) =>
    set((s) => {
      if (s.activeWaypointId !== waypointId) return {};
      // Leaving the zone must not hide a Deep Dive the user is still listening to.
      if (s.deepDiveWaypointId === waypointId) return {};
      return { activeWaypointId: null, isPlaying: false, positionSeconds: 0, durationSeconds: 0 };
    }),

  startDeepDive: (waypointId) => set({ deepDiveWaypointId: waypointId, playbackError: null }),

  endDeepDive: () => set({ deepDiveWaypointId: null }),

  dismissCompletionPrompt: () => set({ completionPrompted: false }),

  applyEngineView: ({ visitedWaypointIds }) =>
    set((s) =>
      // Same array when unchanged, so the map does not re-render every heartbeat.
      s.visitedWaypointIds.length === visitedWaypointIds.length &&
      s.visitedWaypointIds.every((id, i) => id === visitedWaypointIds[i])
        ? {}
        : { visitedWaypointIds },
    ),

  setOnAir: (waypointId, deepDive) =>
    set((s) => ({
      activeWaypointId: waypointId,
      deepDiveWaypointId: waypointId !== null && deepDive ? waypointId : null,
      // A new stop on air clears a stale error from the previous one.
      playbackError: waypointId !== null && waypointId !== s.activeWaypointId ? null : s.playbackError,
      ...(waypointId === null ? { isPlaying: false, positionSeconds: 0, durationSeconds: 0 } : {}),
    })),

  promptCompletion: () => set({ completionPrompted: true }),
}));

/** Selectors, so subscribers only re-render on the slice they actually read. */
export const selectStatus = (s: TourSessionState): SessionStatus => s.status;
export const selectFix = (s: TourSessionState): LatLng | null => s.currentFix;
export const selectWaypoints = (s: TourSessionState): Waypoint[] => s.waypoints;
export const selectActiveWaypointId = (s: TourSessionState): string | null => s.activeWaypointId;
