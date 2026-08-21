import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { isSupabaseConfigured } from '../services/supabase/client';
import { fetchTours } from '../services/supabase/tours';
import type { DiscoveryScreenProps } from '../navigation/types';
import type { Tour } from '../types/domain';

/** Human labels for the enum-ish columns; PRD Screen 1 shows topology + mode. */
const TOPOLOGY_LABEL: Record<string, string> = {
  in_city: 'In-city',
  point_to_point: 'Point to point',
  star_loop: 'Star / loop',
};

const TRANSIT_LABEL: Record<string, string> = {
  walking: 'Walking',
  biking: 'Biking',
  driving: 'Driving',
};

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; tours: Tour[] }
  | { status: 'error'; message: string };

/**
 * Screen 1 - Tour Discovery (PRD v2.0.0).
 *
 * Fetches the catalogue with the anon key, so it doubles as a live check that
 * the public-read RLS policy works from a real client.
 *
 * Four distinct states are rendered rather than collapsed into one spinner:
 * unconfigured, loading, error, and empty are different problems with different
 * fixes, and telling them apart is most of the debugging value.
 */
export default function DiscoveryScreen({ navigation }: DiscoveryScreenProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) {
      setState({
        status: 'error',
        message:
          'Supabase is not configured.\n\nCopy mobile/.env.example to mobile/.env, add your anon key, then restart the dev server.',
      });
      return;
    }
    try {
      setState({ status: 'ready', tours: await fetchTours() });
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Could not load tours.',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (state.status === 'loading') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
        <Text style={styles.muted}>Loading tours…</Text>
      </View>
    );
  }

  if (state.status === 'error') {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorTitle}>Could not load tours</Text>
        <Text style={styles.muted}>{state.message}</Text>
        <Pressable style={styles.retry} onPress={() => void load()}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <FlatList
      data={state.tours}
      keyExtractor={(t) => t.id}
      contentContainerStyle={state.tours.length === 0 ? styles.flexFill : styles.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
      ListEmptyComponent={
        <View style={styles.centered}>
          <Text style={styles.errorTitle}>No tours yet</Text>
          <Text style={styles.muted}>
            The catalogue is empty. Seed data is local-only, so a remote database with no
            published tours will look like this. Pull to refresh.
          </Text>
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
          onPress={() => navigation.navigate('TourDetail', { tourId: item.id, title: item.title })}
        >
          <Text style={styles.cardTitle}>{item.title}</Text>
          <View style={styles.metaRow}>
            <Text style={styles.badge}>{TOPOLOGY_LABEL[item.topology] ?? item.topology}</Text>
            <Text style={styles.badge}>{TRANSIT_LABEL[item.transitMode] ?? item.transitMode}</Text>
            <Text style={styles.muted}>{item.durationMinutes} min</Text>
          </View>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 12 },
  flexFill: { flexGrow: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  muted: { fontSize: 14, opacity: 0.6, textAlign: 'center', lineHeight: 20 },
  errorTitle: { fontSize: 17, fontWeight: '600' },
  retry: { marginTop: 8, paddingVertical: 10, paddingHorizontal: 22, borderRadius: 8, backgroundColor: '#1C1C1E' },
  retryText: { color: '#FFFFFF', fontWeight: '600' },
  card: { padding: 16, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: '#C7C7CC', gap: 10 },
  cardPressed: { opacity: 0.6 },
  cardTitle: { fontSize: 17, fontWeight: '600' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  badge: { fontSize: 12, overflow: 'hidden', paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, backgroundColor: '#EFEFF4' },
});
