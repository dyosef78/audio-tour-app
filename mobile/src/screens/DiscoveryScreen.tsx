import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  GROUP_TYPES,
  INTERESTS,
  TIME_BUDGETS,
  labelFor,
  routeCriteria,
  tourFitsBudget,
} from '../personalization/options';
import { refreshCities, useCityCatalogue } from '../personalization/cityCatalogue';
import { catalogueCityId, resolveCity } from '../personalization/onboardingFlow';
import { usePreferences } from '../personalization/preferencesStore';
import { TourBundleRepository } from '../services/bundle/TourBundleRepository';
import { networkMonitor } from '../services/network/NetworkMonitor';
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
  | { status: 'ready'; tours: Tour[]; source: 'live' | 'offline' }
  | { status: 'error'; message: string };

/**
 * Screen 1 - Tour Discovery (PRD v2.0.0).
 *
 * Fetches the catalogue with the anon key, so it doubles as a live check that
 * the public-read RLS policy works from a real client.
 *
 * HYBRID OFFLINE-FIRST (TASK-605). With no connection this screen used to show
 * "Could not load tours" - and nothing else, so a tour downloaded precisely for
 * a dead zone could not be opened in one. Now:
 *   * the live catalogue when it loads;
 *   * otherwise the tours already downloaded, from their manifests, under a
 *     banner saying so;
 *   * an error only when there is neither;
 *   * and the moment connectivity returns, an offline list or an error reloads
 *     by itself.
 *
 * Personalisation (TASK-601): the time budget is the only preference the
 * catalogue can act on today, so tours that fit it sort first and are badged.
 *
 * City (TASK-1101): the catalogue is the saved city's. Each load refreshes the
 * city list first; a single city is selected silently (which re-runs the load
 * through the cityId dependency), several with no valid choice list every tour
 * under a "choose your city" prompt. With no city list at all - offline, or a
 * database without the cities migration - nothing is filtered. Downloaded tours
 * shown offline are never filtered: they were downloaded on purpose.
 */
export default function DiscoveryScreen({ navigation }: DiscoveryScreenProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const stateRef = useRef(state);
  stateRef.current = state;

  const groupType = usePreferences((s) => s.groupType);
  const interests = usePreferences((s) => s.interests);
  const timeBudget = usePreferences((s) => s.timeBudget);
  const cityId = usePreferences((s) => s.cityId);
  const cities = useCityCatalogue((s) => s.cities);
  const cityName = cities?.find((c) => c.id === cityId)?.name ?? null;
  const multipleCities = (cities?.length ?? 0) >= 2;
  const needsCity = multipleCities && cityName === null;
  const criteria = useMemo(
    () => routeCriteria({ groupType, interests, timeBudget }),
    [groupType, interests, timeBudget],
  );

  const editPreferences = useCallback(() => {
    navigation.navigate('OnboardingGroup', { editing: true });
  }, [navigation]);

  const chooseCity = useCallback(() => {
    navigation.navigate('OnboardingCity', { editing: true });
  }, [navigation]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: cityName ?? 'Audio Tours',
      headerRight: () => (
        <Pressable hitSlop={12} onPress={editPreferences} accessibilityRole="button">
          <Text style={styles.headerLink}>Preferences</Text>
        </Pressable>
      ),
    });
  }, [navigation, editPreferences, cityName]);

  const load = useCallback(async () => {
    // The tours on this device, or the error if there are none.
    const offlineOr = (message: string): void => {
      const downloaded = TourBundleRepository.listDownloadedTours();
      setState(
        downloaded.length > 0
          ? { status: 'ready', tours: downloaded, source: 'offline' }
          : { status: 'error', message },
      );
    };

    if (!isSupabaseConfigured) {
      offlineOr(
        'Supabase is not configured.\n\nCopy mobile/.env.example to mobile/.env, add your anon key, then restart the dev server.',
      );
      return;
    }
    await refreshCities();
    const prefs = usePreferences.getState();
    const resolution = resolveCity(useCityCatalogue.getState().cities, prefs.cityId);
    if (resolution.kind === 'auto' && resolution.cityId !== prefs.cityId) {
      // Saving it changes cityId, which runs this load again - that run fetches.
      prefs.setCity(resolution.cityId);
      return;
    }
    try {
      const tours = await fetchTours(catalogueCityId(resolution, prefs.cityId));
      setState({ status: 'ready', tours, source: 'live' });
    } catch (err) {
      offlineOr(err instanceof Error ? err.message : 'Could not load tours.');
    }
  }, []);

  // cityId is a dependency, not read inside: choosing or auto-selecting a city
  // is what reloads the catalogue.
  useEffect(() => {
    void load();
  }, [load, cityId]);

  // Reload when the connection returns - but only if what is on screen is the
  // offline fallback or an error. A live list does not need a second fetch
  // just because the monitor reported its first reading.
  useEffect(
    () =>
      networkMonitor.subscribe((online) => {
        const current = stateRef.current;
        const stale = current.status === 'error' || (current.status === 'ready' && current.source === 'offline');
        if (online && stale) void load();
      }),
    [load],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const tours = useMemo(() => {
    if (state.status !== 'ready') return [];
    if (criteria === null) return state.tours;
    // Stable sort: fitting tours first, title order kept within each group.
    const fits = (t: Tour): number => (tourFitsBudget(t.durationMinutes, criteria) ? 0 : 1);
    return [...state.tours].sort((a, b) => fits(a) - fits(b));
  }, [state, criteria]);

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
      data={tours}
      keyExtractor={(t) => t.id}
      contentContainerStyle={tours.length === 0 ? styles.flexFill : styles.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
      ListHeaderComponent={
        <>
          {state.source === 'offline' && (
            <View style={styles.offline} accessibilityRole="alert">
              <Text style={styles.offlineTitle}>You are offline</Text>
              <Text style={styles.offlineText}>
                Showing the tours downloaded to this device. The full catalogue comes back as soon
                as you reconnect.
              </Text>
            </View>
          )}
          {state.source === 'live' && needsCity && (
            <Pressable
              style={({ pressed }) => [styles.cityPrompt, pressed && styles.cardPressed]}
              onPress={chooseCity}
              accessibilityRole="button"
            >
              <Text style={styles.cityPromptTitle}>📍 Where are you exploring?</Text>
              <Text style={styles.cityPromptText}>Choose a city to see its tours. Showing every city for now.</Text>
            </Pressable>
          )}
          {state.source === 'live' && multipleCities && !needsCity && (
            <Pressable onPress={chooseCity} accessibilityRole="button" hitSlop={8} style={styles.cityRow}>
              <Text style={styles.cityRowText}>📍 {cityName}</Text>
              <Text style={styles.headerLink}>Change city</Text>
            </Pressable>
          )}
          {criteria && timeBudget ? (
            <Pressable
              style={({ pressed }) => [styles.prefs, pressed && styles.cardPressed]}
              onPress={editPreferences}
              accessibilityRole="button"
              accessibilityHint="Edit your preferences"
            >
              <Text style={styles.prefsEyebrow}>PLANNED FOR YOU</Text>
              <Text style={styles.prefsTitle}>
                {labelFor(GROUP_TYPES, criteria.groupType)} · {labelFor(TIME_BUDGETS, timeBudget)}
              </Text>
              <Text style={styles.prefsSub} numberOfLines={2}>
                {criteria.interests.map((i) => labelFor(INTERESTS, i)).join(', ')}
              </Text>
            </Pressable>
          ) : null}
        </>
      }
      ListEmptyComponent={
        <View style={styles.centered}>
          <Text style={styles.errorTitle}>No tours yet</Text>
          <Text style={styles.muted}>
            The catalogue is empty. Seed data is local-only, so a remote database with no
            published tours will look like this. Pull to refresh.
          </Text>
        </View>
      }
      renderItem={({ item }) => {
        const fits = tourFitsBudget(item.durationMinutes, criteria);
        return (
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
            {fits !== null && (
              <Text style={[styles.fit, !fits && styles.fitNo]}>
                {fits ? '✓ Fits your time' : 'Longer than your time'}
              </Text>
            )}
          </Pressable>
        );
      }}
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
  headerLink: { color: '#0C6C6A', fontSize: 15, fontWeight: '600' },
  offline: { padding: 14, borderRadius: 12, backgroundColor: '#FBF0E0', gap: 2, marginBottom: 12 },
  offlineTitle: { fontSize: 14, fontWeight: '700', color: '#8A5A00' },
  offlineText: { fontSize: 13, lineHeight: 18, color: '#6B4A12' },
  cityPrompt: { padding: 16, borderRadius: 14, borderWidth: 1.5, borderColor: '#0C6C6A', gap: 4, marginBottom: 12 },
  cityPromptTitle: { fontSize: 16, fontWeight: '700', color: '#1C1C1E' },
  cityPromptText: { fontSize: 13, lineHeight: 18, color: '#3A3A3C' },
  cityRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 44, marginBottom: 4 },
  cityRowText: { fontSize: 15, fontWeight: '600', color: '#1C1C1E' },
  prefs: { padding: 16, borderRadius: 14, backgroundColor: '#E3F1F0', gap: 3 },
  prefsEyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, color: '#0C6C6A' },
  prefsTitle: { fontSize: 16, fontWeight: '700', color: '#1C1C1E' },
  prefsSub: { fontSize: 13, color: '#3A3A3C' },
  card: { padding: 16, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: '#C7C7CC', gap: 10 },
  cardPressed: { opacity: 0.6 },
  cardTitle: { fontSize: 17, fontWeight: '600' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  badge: { fontSize: 12, overflow: 'hidden', paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, backgroundColor: '#EFEFF4' },
  fit: { fontSize: 13, fontWeight: '600', color: '#1B7A45' },
  fitNo: { color: '#6E6E73', fontWeight: '500' },
});
