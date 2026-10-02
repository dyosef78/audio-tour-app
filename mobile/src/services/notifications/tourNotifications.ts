import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/**
 * Local notifications for the running tour (Epic 15).
 *
 *   tour_suspended   the idle timeout stopped tracking
 *   chapter_arrived  the chapter's destination was reached: "start the next"
 *
 * A notification is the only sanctioned way to bring the app forward while
 * Google Maps is navigating: iOS never lets an app foreground itself, and
 * Android 10+ forbids launching an activity from the background. The tap does
 * it - and that tap is also what lets Android restart tracking for the next
 * chapter, which only works in the foreground.
 *
 * PERMISSION IS LAZY (PM, Slice 5): asked right before the listener leaves
 * for the navigation app (requestTourNotificationPermission), never at app or
 * tour start - prompt fatigue. Without it, both states still show in the app.
 *
 * Local only: nothing registers for push. expo-notifications' config plugin
 * still adds the aps-environment entitlement, so iOS builds carry the Push
 * capability - expected, and unused.
 */

const CHANNEL_ID = 'tour-status';

/** Data carried by our notifications - the tap handler's routing table. */
export type TourNotificationData =
  | { kind: 'tour_suspended'; tourId: string }
  | { kind: 'chapter_arrived'; tourId: string; chapterId: string; nextChapterId: string | null };

// Shown even with the app open: the in-app banner says the same, but the
// listener with the phone in a pocket or under Google Maps is why this exists.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

let channelReady: Promise<void> | null = null;
/** Android's channel - required to post, and never prompts. */
function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return Promise.resolve();
  channelReady ??= Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Tour status',
    importance: Notifications.AndroidImportance.DEFAULT,
  }).then(() => undefined);
  return channelReady;
}

/**
 * Ask - the lazy moment is the tap on "Navigate". iOS shows its prompt once;
 * Android 13+ already granted or refused POST_NOTIFICATIONS when tracking
 * started (Epic 13). A refusal is an answer, not an error.
 */
export async function requestTourNotificationPermission(): Promise<boolean> {
  await ensureChannel();
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

const posted = new Map<TourNotificationData['kind'], string>();

async function post(data: TourNotificationData, title: string, body: string): Promise<void> {
  await ensureChannel();
  const previous = posted.get(data.kind);
  if (previous) await Notifications.dismissNotificationAsync(previous);
  const id = await Notifications.scheduleNotificationAsync({
    content: { title, body, data },
    trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null,
  });
  posted.set(data.kind, id);
}

export async function notifyTourSuspended(tourId: string, tourTitle: string): Promise<void> {
  await post(
    { kind: 'tour_suspended', tourId },
    'Tour paused due to inactivity',
    `${tourTitle}: location tracking stopped after 15 minutes without moving. Open the app to resume.`,
  );
}

export async function notifyChapterArrived(args: {
  tourId: string;
  chapterId: string;
  nextChapterId: string | null;
  destinationLabel: string | null;
  nextChapterTitle: string | null;
}): Promise<void> {
  const where = args.destinationLabel ?? 'your destination';
  await post(
    { kind: 'chapter_arrived', tourId: args.tourId, chapterId: args.chapterId, nextChapterId: args.nextChapterId },
    `You've arrived at ${where}`,
    args.nextChapterTitle ? `Tap to start "${args.nextChapterTitle}".` : 'Tap to return to your tour.',
  );
}

export async function dismissTourNotification(kind: TourNotificationData['kind']): Promise<void> {
  const id = posted.get(kind);
  posted.delete(kind);
  if (id) await Notifications.dismissNotificationAsync(id);
}

function isTourData(value: unknown): value is TourNotificationData {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return (d.kind === 'tour_suspended' || d.kind === 'chapter_arrived') && typeof d.tourId === 'string';
}

/**
 * Route taps on our notifications - while running, and the tap that cold-
 * started the app. Returns the unsubscribe. Taps on anything else are ignored.
 */
export function onTourNotificationTap(handler: (data: TourNotificationData) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data;
    if (isTourData(data)) handler(data);
  });
  void Notifications.getLastNotificationResponseAsync().then((response) => {
    const data = response?.notification.request.content.data;
    if (isTourData(data)) handler(data);
  });
  return () => sub.remove();
}
