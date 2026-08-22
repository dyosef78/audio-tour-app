import { create } from 'zustand';

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
  waypoints: Waypoint[];

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
  /** Waypoints whose geofence has been entered at least once. */
  visitedWaypointIds: string[];

  /**
   * All waypoints visited. Per the PM decision this only PROMPTS - it never
   * ends the session, so a user can linger at the last stop.
   */
  completionPrompted: boolean;

  /** Whether background location permission was granted, for honest UI. */
  backgroundPermission: boolean;
  error: string | null;
}

export interface TourSessionActions {
  beginStart: (tourId: string, tourTitle: string) => void;
  sessionStarted: (args: {
    waypoints: Waypoint[];
    transitMode: TransitMode;
    backgroundPermission: boolean;
  }) => void;
  sessionFailed: (message: string) => void;
  reset: () => void;

  setFix: (fix: LatLng, accuracyMeters: number | null) => void;
  setSamplingTier: (tier: 'coarse' | 'fine') => void;

  setPlaybackError: (message: string | null) => void;
  setPlayback: (snapshot: { isPlaying: boolean; positionSeconds: number; durationSeconds: number }) => void;
  markEntered: (waypointId: string) => void;
  markExited: (waypointId: string) => void;
  dismissCompletionPrompt: () => void;
}

const initial: TourSessionState = {
  status: 'idle',
  tourId: null,
  tourTitle: null,
  transitMode: null,
  waypoints: [],
  currentFix: null,
  accuracyMeters: null,
  samplingTier: 'coarse',
  playbackError: null,
  isPlaying: false,
  positionSeconds: 0,
  durationSeconds: 0,
  activeWaypointId: null,
  visitedWaypointIds: [],
  completionPrompted: false,
  backgroundPermission: false,
  error: null,
};

export const useTourSession = create<TourSessionState & TourSessionActions>((set) => ({
  ...initial,

  beginStart: (tourId, tourTitle) =>
    set({ ...initial, status: 'starting', tourId, tourTitle }),

  sessionStarted: ({ waypoints, transitMode, backgroundPermission }) =>
    set({ status: 'active', waypoints, transitMode, backgroundPermission, error: null }),

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
      };
    }),

  markExited: (waypointId) =>
    set((s) =>
      s.activeWaypointId === waypointId
        ? { activeWaypointId: null, isPlaying: false, positionSeconds: 0, durationSeconds: 0 }
        : {},
    ),

  dismissCompletionPrompt: () => set({ completionPrompted: false }),
}));

/** Selectors, so subscribers only re-render on the slice they actually read. */
export const selectStatus = (s: TourSessionState): SessionStatus => s.status;
export const selectFix = (s: TourSessionState): LatLng | null => s.currentFix;
export const selectWaypoints = (s: TourSessionState): Waypoint[] => s.waypoints;
export const selectActiveWaypointId = (s: TourSessionState): string | null => s.activeWaypointId;
