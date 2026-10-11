/**
 * `expo-notifications` for the Node harness (Epic 17, TASK-1702).
 *
 * Records what was scheduled and dismissed, so the controller test can assert
 * "the tour was paused and said so", and replays a tap the way the OS does.
 */

export const AndroidImportance = { DEFAULT: 3 } as const;

export interface Scheduled {
  id: string;
  content: { title?: string; body?: string; data?: Record<string, unknown> };
}

export const scheduled: Scheduled[] = [];
export const dismissed: string[] = [];
let nextId = 1;

export function setNotificationHandler(_handler: unknown): void {}
export async function setNotificationChannelAsync(_id: string, _channel: unknown): Promise<null> {
  return null;
}
export async function getPermissionsAsync(): Promise<{ granted: boolean }> {
  return { granted: true };
}
export async function requestPermissionsAsync(): Promise<{ granted: boolean }> {
  return { granted: true };
}
export async function scheduleNotificationAsync(request: { content: Scheduled['content'] }): Promise<string> {
  const id = `n${nextId++}`;
  scheduled.push({ id, content: request.content });
  return id;
}
export async function dismissNotificationAsync(id: string): Promise<void> {
  dismissed.push(id);
}

type ResponseListener = (response: { notification: { request: { content: Scheduled['content'] } } }) => void;
const listeners = new Set<ResponseListener>();
export function addNotificationResponseReceivedListener(listener: ResponseListener): { remove: () => void } {
  listeners.add(listener);
  return { remove: () => listeners.delete(listener) };
}
export async function getLastNotificationResponseAsync(): Promise<null> {
  return null;
}

/** Simulate the visitor tapping a notification this stub recorded. */
export function __tap(id: string): void {
  const n = scheduled.find((s) => s.id === id);
  if (!n) throw new Error(`stub notifications: no notification ${id}`);
  for (const l of [...listeners]) l({ notification: { request: { content: n.content } } });
}

export function __resetNotifications(): void {
  scheduled.length = 0;
  dismissed.length = 0;
  listeners.clear();
}
