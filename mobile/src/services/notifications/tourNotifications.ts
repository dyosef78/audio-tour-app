import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/**
 * Local notifications for the running tour (Epic 15).
 *
 * Today one: "Tour paused due to inactivity" when the engine's idle timeout
 * suspends tracking. Slice 5 adds the chapter-arrival prompt the same way -
 * a notification is the only sanctioned way to bring the app forward while
 * Google Maps is navigating (iOS cannot, and Android 10+ forbids, an app
 * launching itself from the background).
 *
 * Local only: nothing here registers for push. expo-notifications' config
 * plugin still adds the aps-environment entitlement, so the next iOS build
 * enables the Push capability on the App ID - expected, and unused.
 */

const CHANNEL_ID = 'tour-status';

// Shown even with the app open: the in-app banner says the same, but a
// listener with the phone in a pocket is the reason this exists.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

let suspendedNotificationId: string | null = null;

/**
 * Ask once, at tour start. iOS needs an explicit permission; Android's
 * POST_NOTIFICATIONS is already requested by LocationService (Epic 13) and
 * needs a channel instead. A refusal is not an error: the tour runs, and the
 * paused state still shows in the app.
 */
export async function prepareTourNotifications(): Promise<boolean> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Tour status',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

export async function notifyTourSuspended(tourTitle: string): Promise<void> {
  await dismissTourSuspended();
  suspendedNotificationId = await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Tour paused due to inactivity',
      body: `${tourTitle}: location tracking stopped after 15 minutes without moving. Open the app to resume.`,
      data: { kind: 'tour_suspended' },
    },
    trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null,
  });
}

export async function dismissTourSuspended(): Promise<void> {
  const id = suspendedNotificationId;
  suspendedNotificationId = null;
  if (id !== null) await Notifications.dismissNotificationAsync(id);
}
