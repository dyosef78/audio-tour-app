import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { TourBundleRepository } from '../services/bundle/TourBundleRepository';
import type { BundleProgress } from '../services/bundle/types';
import { networkMonitor } from '../services/network/NetworkMonitor';
import { useTourSession } from '../session/tourSessionStore';
import type { TourDetailScreenProps } from '../navigation/types';

/**
 * Screen 2 - Tour Detail & Offline Bundle Pre-fetch (PRD v2.0.0, TASK-201).
 *
 * "Start Tour" unlocks only once a complete, verified bundle is on disk. That
 * is the whole point of the screen: everything past here must work with the
 * radio off.
 *
 * HYBRID OFFLINE-FIRST (TASK-605). A downloaded bundle used to be final: this
 * screen showed "ready" forever and never asked the server again, so corrected
 * audio, new routes and transcripts never reached a phone that already had the
 * tour. And a download that failed for want of signal waited for a tap. Now,
 * whenever a connection is available:
 *   * a downloaded tour is compared with the server's bundle_version_hash, and
 *     an update is offered - never forced, since it may be large and on
 *     cellular data; the old bundle keeps working until the new one commits;
 *   * a download that failed resumes by itself when connectivity returns.
 * Neither happens for the tour that is currently RUNNING: replacing its bundle
 * directory would delete the files it is playing from.
 */

type UpdateState = 'unknown' | 'checking' | 'current' | 'available' | 'failed';

type State =
  | { phase: 'checking' }
  | { phase: 'idle' }
  | { phase: 'downloading'; progress: BundleProgress }
  | { phase: 'ready'; update: UpdateState }
  | { phase: 'error'; message: string };

const fmtMB = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

export default function TourDetailScreen({ route, navigation }: TourDetailScreenProps) {
  const { tourId, title } = route.params;
  const [state, setState] = useState<State>({ phase: 'checking' });

  const stateRef = useRef(state);
  stateRef.current = state;

  const tourRunning = useTourSession(
    (s) => s.tourId === tourId && (s.status === 'active' || s.status === 'starting'),
  );

  /** Guards setState after unmount - a download outlives a fast back-press. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setState(
      TourBundleRepository.isDownloaded(tourId) ? { phase: 'ready', update: 'unknown' } : { phase: 'idle' },
    );
  }, [tourId]);

  const startDownload = useCallback(async () => {
    const hadBundle = TourBundleRepository.isDownloaded(tourId);
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
      if (mounted.current) setState({ phase: 'ready', update: 'current' });
    } catch (err) {
      if (!mounted.current) return;
      // A failed UPDATE must not take away a tour that still works: the old
      // bundle is untouched until the new one commits.
      if (hadBundle && TourBundleRepository.isDownloaded(tourId)) {
        setState({ phase: 'ready', update: 'failed' });
        return;
      }
      setState({
        phase: 'error',
        message: err instanceof Error ? err.message : 'Download failed.',
      });
    }
  }, [tourId]);

  const checkForUpdate = useCallback(async () => {
    if (!mounted.current) return;
    setState((s) => (s.phase === 'ready' ? { phase: 'ready', update: 'checking' } : s));
    try {
      const freshness = await TourBundleRepository.checkForUpdate(tourId);
      if (mounted.current) {
        setState((s) =>
          s.phase === 'ready'
            ? { phase: 'ready', update: freshness === 'update_available' ? 'available' : 'current' }
            : s,
        );
      }
    } catch {
      // Unreachable, or unpublished since: say nothing, keep the working bundle,
      // and let the next reconnect try again.
      if (mounted.current) setState((s) => (s.phase === 'ready' ? { phase: 'ready', update: 'unknown' } : s));
    }
  }, [tourId]);

  // Online now and never checked: check.
  const needsCheck = state.phase === 'ready' && state.update === 'unknown';
  useEffect(() => {
    if (needsCheck && networkMonitor.isOnline()) void checkForUpdate();
  }, [needsCheck, checkForUpdate]);

  // Connectivity returned: finish what the outage interrupted. Once per
  // reconnect, never in a loop - an error that is not about the network (an
  // unpublished tour) is retried on the next reconnect, not continuously.
  useEffect(
    () =>
      networkMonitor.subscribe((online) => {
        if (!online) return;
        const current = stateRef.current;
        if (current.phase === 'error') void startDownload();
        else if (current.phase === 'ready' && current.update === 'unknown') void checkForUpdate();
      }),
    [startDownload, checkForUpdate],
  );

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
            {state.progress.filesCompleted} of {state.progress.filesTotal} files
          </Text>
        </>
      )}

      {state.phase === 'ready' && (
        <>
          <Text style={styles.ready}>Downloaded — ready to play offline</Text>

          {state.update === 'checking' && <Text style={styles.hint}>Checking for updates…</Text>}

          {(state.update === 'available' || state.update === 'failed') &&
            (tourRunning ? (
              <Text style={styles.hint}>An update is available. You can download it once this tour ends.</Text>
            ) : (
              <>
                <Text style={styles.hint}>
                  {state.update === 'failed'
                    ? 'The update did not finish. The downloaded version still works.'
                    : 'A newer version of this tour is available.'}
                </Text>
                <Pressable style={styles.secondary} onPress={() => void startDownload()}>
                  <Text style={styles.secondaryText}>
                    {state.update === 'failed' ? 'Retry update' : 'Download update'}
                  </Text>
                </Pressable>
              </>
            ))}

          <Pressable
            style={styles.primary}
            onPress={() => navigation.navigate('ActiveTour', { tourId })}
          >
            <Text style={styles.primaryText}>Start Tour</Text>
          </Pressable>

          {/* Removing the files a running tour plays from would silence it. */}
          {!tourRunning && (
            <Pressable onPress={removeDownload} hitSlop={8}>
              <Text style={styles.link}>Remove download</Text>
            </Pressable>
          )}
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
            Finished parts are kept, so resuming continues where it stopped. It resumes by itself
            when your connection returns.
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
  hint: { fontSize: 12, opacity: 0.6, textAlign: 'center', lineHeight: 17 },
  ready: { fontSize: 15, fontWeight: '600', color: '#1B7A45' },
  errorTitle: { fontSize: 16, fontWeight: '600' },
  primary: { marginTop: 4, paddingVertical: 13, paddingHorizontal: 28, borderRadius: 8, backgroundColor: '#1C1C1E' },
  primaryText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },
  secondary: {
    paddingVertical: 10, paddingHorizontal: 22, borderRadius: 8,
    borderWidth: 1.5, borderColor: '#0C6C6A',
  },
  secondaryText: { color: '#0C6C6A', fontWeight: '600', fontSize: 14 },
  link: { fontSize: 13, opacity: 0.6, textDecorationLine: 'underline' },
  track: { width: '100%', height: 8, borderRadius: 4, backgroundColor: '#E4E4E8', overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4, backgroundColor: '#1C1C1E' },
  progressText: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
