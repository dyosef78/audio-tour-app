import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { TourBundleRepository } from '../services/bundle/TourBundleRepository';
import type { BundleProgress } from '../services/bundle/types';
import type { TourDetailScreenProps } from '../navigation/types';

/**
 * Screen 2 - Tour Detail & Offline Bundle Pre-fetch (PRD v2.0.0, TASK-201).
 *
 * "Start Tour" unlocks only once a complete, verified bundle is on disk. That
 * is the whole point of the screen: everything past here must work with the
 * radio off.
 */

type State =
  | { phase: 'checking' }
  | { phase: 'idle' }
  | { phase: 'downloading'; progress: BundleProgress }
  | { phase: 'ready' }
  | { phase: 'error'; message: string };

const fmtMB = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

export default function TourDetailScreen({ route, navigation }: TourDetailScreenProps) {
  const { tourId, title } = route.params;
  const [state, setState] = useState<State>({ phase: 'checking' });

  /** Guards setState after unmount - a download outlives a fast back-press. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setState(TourBundleRepository.isDownloaded(tourId) ? { phase: 'ready' } : { phase: 'idle' });
  }, [tourId]);

  const startDownload = useCallback(async () => {
    setState({
      phase: 'downloading',
      progress: { bytesWritten: 0, totalBytes: 0, filesCompleted: 0, filesTotal: 0, fraction: 0 },
    });

    try {
      await TourBundleRepository.download(tourId, {
        onProgress: (progress) => {
          if (mounted.current) setState({ phase: 'downloading', progress });
        },
      });
      if (mounted.current) setState({ phase: 'ready' });
    } catch (err) {
      if (mounted.current) {
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'Download failed.',
        });
      }
    }
  }, [tourId]);

  const removeDownload = useCallback(() => {
    TourBundleRepository.remove(tourId);
    setState({ phase: 'idle' });
  }, [tourId]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>

      {state.phase === 'checking' && <ActivityIndicator />}

      {state.phase === 'idle' && (
        <>
          <Text style={styles.muted}>
            Download this tour to play it with no signal. Audio and stop locations are saved to
            your device.
          </Text>
          <Pressable style={styles.primary} onPress={() => void startDownload()}>
            <Text style={styles.primaryText}>Download Tour</Text>
          </Pressable>
        </>
      )}

      {state.phase === 'downloading' && (
        <>
          <View style={styles.track} accessibilityRole="progressbar">
            <View style={[styles.fill, { width: `${Math.round(state.progress.fraction * 100)}%` }]} />
          </View>
          <Text style={styles.progressText}>
            {Math.round(state.progress.fraction * 100)}%
            {state.progress.totalBytes > 0 &&
              ` · ${fmtMB(state.progress.bytesWritten)} of ${fmtMB(state.progress.totalBytes)}`}
          </Text>
          <Text style={styles.muted}>
            {state.progress.filesCompleted} of {state.progress.filesTotal} tracks
          </Text>
        </>
      )}

      {state.phase === 'ready' && (
        <>
          <Text style={styles.ready}>Downloaded — ready to play offline</Text>
          <Pressable
            style={styles.primary}
            onPress={() => navigation.navigate('ActiveTour', { tourId })}
          >
            <Text style={styles.primaryText}>Start Tour</Text>
          </Pressable>
          <Pressable onPress={removeDownload} hitSlop={8}>
            <Text style={styles.link}>Remove download</Text>
          </Pressable>
        </>
      )}

      {state.phase === 'error' && (
        <>
          <Text style={styles.errorTitle}>Download failed</Text>
          <Text style={styles.muted}>{state.message}</Text>
          <Pressable style={styles.primary} onPress={() => void startDownload()}>
            <Text style={styles.primaryText}>Resume download</Text>
          </Pressable>
          <Text style={styles.hint}>
            Finished parts are kept, so resuming continues where it stopped.
          </Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 14 },
  title: { fontSize: 20, fontWeight: '600', textAlign: 'center' },
  muted: { fontSize: 14, opacity: 0.6, textAlign: 'center', lineHeight: 20 },
  hint: { fontSize: 12, opacity: 0.5, textAlign: 'center' },
  ready: { fontSize: 15, fontWeight: '600', color: '#1B7A45' },
  errorTitle: { fontSize: 16, fontWeight: '600' },
  primary: { marginTop: 4, paddingVertical: 13, paddingHorizontal: 28, borderRadius: 8, backgroundColor: '#1C1C1E' },
  primaryText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },
  link: { fontSize: 13, opacity: 0.6, textDecorationLine: 'underline' },
  track: { width: '100%', height: 8, borderRadius: 4, backgroundColor: '#E4E4E8', overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4, backgroundColor: '#1C1C1E' },
  progressText: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
