import { useSyncExternalStore } from 'react';
import { File, Paths } from 'expo-file-system';

import { createPlanRepository, type PlanStoreIO, type SavedPlan } from './planRepository';

const MAIN = 'saved-plans.json';
const TEMP = 'saved-plans.json.tmp';
const file = (name: string): File => new File(Paths.document, name);

/** Write-then-rename, like the session checkpoint: a crash mid-write keeps the old file. */
const planFileIO: PlanStoreIO = {
  read() {
    const main = file(MAIN);
    if (main.exists) return main.textSync();
    // A crash between delete and rename leaves only the temp file - which is complete.
    const temp = file(TEMP);
    return temp.exists ? temp.textSync() : null;
  },
  write(text) {
    file(TEMP).write(text);
    const main = file(MAIN);
    if (main.exists) main.delete();
    file(TEMP).rename(MAIN);
  },
};

/** The app's one plan repository. Loaded synchronously at first import. */
export const savedPlans = createPlanRepository(planFileIO);

/** Saved plans for React, re-rendering on every change. */
export function useSavedPlans(): readonly SavedPlan[] {
  return useSyncExternalStore(savedPlans.subscribe, savedPlans.list);
}
