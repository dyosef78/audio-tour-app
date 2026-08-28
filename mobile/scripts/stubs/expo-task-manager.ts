/**
 * Node stub for `expo-task-manager` (TASK-504). See expo-location.ts.
 *
 * LocationService imports this at module scope but only uses it inside
 * registerBackgroundLocationTask(), which the simulator does not call.
 */

const defined = new Set<string>();

export function isTaskDefined(name: string): boolean {
  return defined.has(name);
}

export function defineTask<T>(name: string, _handler: (body: { data: T; error: unknown }) => void): void {
  defined.add(name);
}
