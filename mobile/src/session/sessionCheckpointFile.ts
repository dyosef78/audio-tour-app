import { File, Paths } from 'expo-file-system';

import { createCheckpointStore, type CheckpointIO } from './sessionCheckpoint';

/**
 * The real CheckpointIO: two small files in the app's document directory,
 * through expo-file-system's synchronous API. Private app storage, so no
 * permission is involved, and it survives process death (not uninstall).
 */
const MAIN = 'tour-session.json';
const TEMP = 'tour-session.json.tmp';

const file = (name: string): File => new File(Paths.document, name);

const read = (name: string): string | null => {
  const f = file(name);
  return f.exists ? f.textSync() : null;
};

const fileIO: CheckpointIO = {
  readMain: () => read(MAIN),
  readTemp: () => read(TEMP),
  writeTemp(text) {
    file(TEMP).write(text);
  },
  commitTemp() {
    const main = file(MAIN);
    if (main.exists) main.delete();
    file(TEMP).rename(MAIN);
  },
  clear() {
    for (const name of [MAIN, TEMP]) {
      const f = file(name);
      if (f.exists) f.delete();
    }
  },
};

export const sessionCheckpoints = createCheckpointStore(fileIO);
