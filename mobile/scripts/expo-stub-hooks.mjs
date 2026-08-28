/**
 * Node module-resolution hooks for the walk simulator (TASK-504).
 *
 * Registered via `node --import ./mobile/scripts/register-stubs.mjs`. Two jobs,
 * both of which exist so the simulator can drive the REAL LocationService
 * rather than a reimplementation - a reimplementation would only ever prove
 * that the reimplementation works.
 *
 *   1. Redirect the two expo packages the engine imports to local stubs. The
 *      genuine modules bind native code at import and throw outside a device.
 *
 *   2. Resolve EXTENSIONLESS relative imports. The mobile sources are written
 *      for Metro, which infers `.ts`; Node ESM requires the extension. Rather
 *      than rewriting app source to suit a test harness, the harness adapts.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STUBS = new Map([
  ['expo-location', './stubs/expo-location.ts'],
  ['expo-task-manager', './stubs/expo-task-manager.ts'],
  ['expo-audio', './stubs/expo-audio.ts'],
  ['expo-constants', './stubs/expo-constants.ts'],
  ['react-native', './stubs/react-native.ts'],
  ['@react-native-async-storage/async-storage', './stubs/async-storage.ts'],
  // Imported for its side effect only; there is no URL to polyfill in Node.
  ['react-native-url-polyfill/auto', './stubs/noop.ts'],
]);

/** Metro's resolution order, narrowed to what this codebase actually uses. */
const CANDIDATES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS.get(specifier);
  if (stub !== undefined) {
    return { shortCircuit: true, url: new URL(stub, import.meta.url).href };
  }

  if (specifier.startsWith('.') && context.parentURL) {
    const base = new URL(specifier, context.parentURL);
    // Only fill in an extension when the literal path does not exist, so a
    // correct specifier is never second-guessed.
    if (!existsSync(fileURLToPath(base))) {
      for (const ext of CANDIDATES) {
        const candidate = new URL(specifier + ext, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) {
          return { shortCircuit: true, url: candidate.href };
        }
      }
    }
  }

  return nextResolve(specifier, context);
}
