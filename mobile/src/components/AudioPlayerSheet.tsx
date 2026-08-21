import { StyleSheet, Text, View } from 'react-native';

/**
 * Screen 4 - Smart Audio Player, a sticky bottom sheet (PRD v2.0.0, TASK-103).
 *
 * STUB. TODO: play/pause, seek bar driven by audio_tracks.duration_seconds,
 * and the karaoke-style scrolling VTT transcript required for accessibility.
 */
export default function AudioPlayerSheet() {
  return (
    <View style={styles.sheet}>
      <Text style={styles.hint}>Screen 4 - Audio Player (stub)</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { padding: 16, borderTopWidth: StyleSheet.hairlineWidth },
  hint: { fontSize: 13, opacity: 0.6 },
});
