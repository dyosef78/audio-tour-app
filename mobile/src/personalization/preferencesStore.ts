import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { GroupType, Interest, TimeBudget } from './options';

/**
 * User preferences from onboarding (TASK-601).
 *
 * A separate store from tourSessionStore on purpose: the session is reset on
 * every cold start and every endSession(), and preferences must survive both.
 * Persisted to AsyncStorage, which the telemetry queue already depends on, so
 * this adds no native module.
 *
 * Selections are written through as the user taps. Editing from Discovery
 * therefore applies immediately; there is no draft to discard, which is why
 * the first onboarding step says "Close" rather than "Cancel" in edit mode.
 */

export interface PreferencesState {
  groupType: GroupType | null;
  interests: Interest[];
  timeBudget: TimeBudget | null;
  /** Gates the initial route. Set only by finishing the last step. */
  onboardingComplete: boolean;
}

export interface PreferencesActions {
  setGroupType: (groupType: GroupType) => void;
  toggleInterest: (interest: Interest) => void;
  setTimeBudget: (timeBudget: TimeBudget) => void;
  completeOnboarding: () => void;
  resetPreferences: () => void;
}

const initial: PreferencesState = {
  groupType: null,
  interests: [],
  timeBudget: null,
  onboardingComplete: false,
};

/**
 * Whether the persisted preferences have been read back yet.
 *
 * NOT derived from `usePreferences.persist.hasHydrated()`. In zustand 5, a
 * storage read that throws skips straight to the catch: hasHydrated stays false
 * and onFinishHydration never fires, so a navigator waiting on either would
 * render a blank screen forever. onRehydrateStorage's callback is the one hook
 * that runs on BOTH outcomes, and it feeds this store.
 */
export const usePreferencesBoot = create<{ ready: boolean; restoreFailed: boolean }>(() => ({
  ready: false,
  restoreFailed: false,
}));

export const usePreferences = create<PreferencesState & PreferencesActions>()(
  persist(
    (set) => ({
      ...initial,

      setGroupType: (groupType) => set({ groupType }),

      toggleInterest: (interest) =>
        set((s) => ({
          interests: s.interests.includes(interest)
            ? s.interests.filter((i) => i !== interest)
            : [...s.interests, interest],
        })),

      setTimeBudget: (timeBudget) => set({ timeBudget }),

      completeOnboarding: () => set({ onboardingComplete: true }),

      resetPreferences: () => set({ ...initial }),
    }),
    {
      name: 'user-preferences',
      // Bump with a `migrate` when an id in options.ts is retired.
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s): PreferencesState => ({
        groupType: s.groupType,
        interests: s.interests,
        timeBudget: s.timeBudget,
        onboardingComplete: s.onboardingComplete,
      }),
      onRehydrateStorage: () => (_state, error) => {
        // A failed restore degrades to first-run onboarding. Showing it again is
        // a nuisance; refusing to start the app is not recoverable in the field.
        if (error !== undefined) {
          console.warn('[Preferences] could not restore saved preferences:', error);
        }
        usePreferencesBoot.setState({ ready: true, restoreFailed: error !== undefined });
      },
    },
  ),
);
