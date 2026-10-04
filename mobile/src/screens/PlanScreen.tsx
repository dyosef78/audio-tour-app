import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import type { TransitMode } from '../../../shared/src/contracts/planTour';
import type { PlanScreenProps } from '../navigation/types';
import { useCityCatalogue } from '../personalization/cityCatalogue';
import { GROUP_TYPES, INTERESTS, TIME_BUDGETS, type GroupType, type Interest } from '../personalization/options';
import { usePreferences } from '../personalization/preferencesStore';
import { planClient } from '../services/planner';
import { buildPlanRequest, formatDuration, PLAN_MINUTE_CHOICES, planErrorCopy, type PlanOrigin } from '../services/planner/planForm';
import { savedPlans } from '../services/planner/planRepositoryFile';
import { usePlacesSearch } from '../services/planner/usePlacesSearch';
import { colors, MIN_TOUCH } from '../ui/theme';

/**
 * Plan my day (Epic 16 final slice): where from, how long, how, with whom and
 * for what. Everything but the origin is prefilled from onboarding; the
 * visitor may change it here without changing their saved preferences.
 *
 * STATE THAT OUTLIVES A RENDER, and who ends it:
 *   the Places session     usePlacesSearch: disposed on unmount (aborts, silences)
 *   the GPS fix            `alive` ref: a late fix after Back is dropped
 *   the plan POST          AbortController: aborted on unmount; the server's
 *                          request_hash makes a repeat of the same form cheap
 * Pushing PlanPreview keeps this screen MOUNTED (native stack), so coming
 * Back finds the form - and the Places session - as they were.
 */

const MODES: readonly { id: TransitMode; label: string }[] = [
  { id: 'walking', label: '🚶 Walking' },
  { id: 'biking', label: '🚲 Biking' },
  { id: 'driving', label: '🚗 Driving' },
];

type Submit = { phase: 'idle' } | { phase: 'planning' } | { phase: 'error'; title: string; message: string; retry: boolean };

export default function PlanScreen({ navigation }: PlanScreenProps) {
  const cityId = usePreferences((s) => s.cityId);
  const prefGroup = usePreferences((s) => s.groupType);
  const prefInterests = usePreferences((s) => s.interests);
  const prefBudget = usePreferences((s) => s.timeBudget);
  const cityName = useCityCatalogue((s) => s.cities?.find((c) => c.id === cityId)?.name ?? null);

  // Onboarding defaults, read ONCE: editing the form never rewrites preferences.
  const [minutes, setMinutes] = useState<number>(() => TIME_BUDGETS.find((b) => b.id === prefBudget)?.maxMinutes ?? 120);
  const [mode, setMode] = useState<TransitMode>('walking');
  const [group, setGroup] = useState<GroupType>(() => prefGroup ?? 'solo');
  const [interests, setInterests] = useState<Interest[]>(() => (prefInterests.length > 0 ? prefInterests : ['history']));
  const [deepDives, setDeepDives] = useState(false);

  const [origin, setOrigin] = useState<PlanOrigin | null>(null);
  const [locating, setLocating] = useState<'idle' | 'locating' | 'denied' | 'failed'>('idle');
  const [submit, setSubmit] = useState<Submit>({ phase: 'idle' });

  const alive = useRef(true);
  const inflight = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      inflight.current?.abort();
    };
  }, []);

  const places = usePlacesSearch(cityId, (o) => setOrigin({ ...o, source: 'address' }));
  // A start chosen for another city would plan from outside this one.
  useEffect(() => {
    setOrigin(null);
    setSubmit({ phase: 'idle' });
  }, [cityId]);

  const useMyLocation = useCallback(async () => {
    setLocating('locating');
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!alive.current) return;
      if (perm.status !== 'granted') {
        setLocating('denied');
        return;
      }
      const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      if (!alive.current) return;
      setOrigin({ lon: fix.coords.longitude, lat: fix.coords.latitude, source: 'gps', label: 'Current location' });
      places.setQuery('');
      setLocating('idle');
    } catch (err) {
      console.warn('[Plan] location failed:', err instanceof Error ? err.message : err);
      if (alive.current) setLocating('failed');
    }
  }, [places]);

  const toggleInterest = (i: Interest) =>
    setInterests((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]));

  const canPlan = cityId !== null && origin !== null && interests.length > 0 && submit.phase !== 'planning';

  const plan = useCallback(async () => {
    if (cityId === null || origin === null) return;
    const request = buildPlanRequest({ cityId, origin, minutes, transitMode: mode, groupType: group, interests, includeDeepDives: deepDives }, new Date());
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    setSubmit({ phase: 'planning' });
    const result = await planClient.plan(request, ctrl.signal);
    if (!alive.current || ctrl.signal.aborted) return;
    inflight.current = null;
    if (result.kind === 'error') {
      setSubmit({ phase: 'error', ...planErrorCopy(result) });
      return;
    }
    savedPlans.putDraft({ plan: result.plan, request, originLabel: origin.label, savedAt: Date.now() });
    setSubmit({ phase: 'idle' });
    navigation.navigate('PlanPreview', { planId: result.plan.plan_id });
  }, [cityId, origin, minutes, mode, group, interests, deepDives, navigation]);

  if (cityId === null) {
    return (
      <View style={styles.centered}>
        <Text style={styles.h2}>Choose a city first</Text>
        <Text style={styles.muted}>Plans are built from one city's tours.</Text>
        <Pressable style={styles.primary} onPress={() => navigation.navigate('OnboardingCity', { editing: true })} accessibilityRole="button">
          <Text style={styles.primaryText}>Choose a city</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.eyebrow}>{cityName ? `PLANNING IN ${cityName.toUpperCase()}` : 'PLANNING'}</Text>

      <Section title="Where do you start?">
        <OriginSearch
          view={places.view}
          origin={origin}
          onChangeText={(t) => {
            places.setQuery(t);
            // Typing again means a new start: the old one no longer matches the field.
            if (origin !== null) setOrigin(null);
          }}
          onPick={places.select}
        />
        <Pressable style={styles.locate} onPress={() => void useMyLocation()} disabled={locating === 'locating'} accessibilityRole="button">
          {locating === 'locating' ? <ActivityIndicator /> : <Text style={styles.link}>📍 Use my current location</Text>}
        </Pressable>
        {locating === 'denied' && <Text style={styles.hint}>Location is off for this app. Search for an address instead.</Text>}
        {locating === 'failed' && <Text style={styles.hint}>Could not find your location. Search for an address instead.</Text>}
        {origin !== null && <Text style={styles.chosen}>✓ Starting from {origin.label}</Text>}
      </Section>

      <Section title="How long do you have?">
        <ChipRow>
          {PLAN_MINUTE_CHOICES.map((m) => (
            <Chip key={m} label={formatDuration(m * 60)} selected={minutes === m} onPress={() => setMinutes(m)} />
          ))}
        </ChipRow>
      </Section>

      <Section title="Getting around">
        <ChipRow>
          {MODES.map((m) => (
            <Chip key={m.id} label={m.label} selected={mode === m.id} onPress={() => setMode(m.id)} />
          ))}
        </ChipRow>
      </Section>

      <Section title="Who's coming?">
        <ChipRow>
          {GROUP_TYPES.map((g) => (
            <Chip key={g.id} label={`${g.icon} ${g.label}`} selected={group === g.id} onPress={() => setGroup(g.id)} />
          ))}
        </ChipRow>
      </Section>

      <Section title="What are you into?">
        <ChipRow>
          {INTERESTS.map((i) => (
            <Chip key={i.id} label={`${i.icon} ${i.label}`} selected={interests.includes(i.id)} onPress={() => toggleInterest(i.id)} />
          ))}
        </ChipRow>
        {interests.length === 0 && <Text style={styles.hint}>Pick at least one.</Text>}
      </Section>

      <View style={styles.switchRow}>
        <View style={styles.flex}>
          <Text style={styles.switchTitle}>Include Deep Dives</Text>
          <Text style={styles.hint}>Longer optional stories, counted in your time.</Text>
        </View>
        <Switch value={deepDives} onValueChange={setDeepDives} />
      </View>

      {submit.phase === 'error' && (
        <View style={styles.errorCard} accessibilityRole="alert">
          <Text style={styles.errorTitle}>{submit.title}</Text>
          <Text style={styles.errorText}>{submit.message}</Text>
        </View>
      )}

      <Pressable
        style={[styles.primary, !canPlan && styles.disabled]}
        onPress={() => void plan()}
        disabled={!canPlan}
        accessibilityRole="button"
        accessibilityState={{ disabled: !canPlan, busy: submit.phase === 'planning' }}
      >
        {submit.phase === 'planning' ? <ActivityIndicator color={colors.canvas} /> : <Text style={styles.primaryText}>{submit.phase === 'error' && submit.retry ? 'Try again' : 'Plan my day'}</Text>}
      </Pressable>
    </ScrollView>
  );
}

function OriginSearch({
  view,
  origin,
  onChangeText,
  onPick,
}: {
  view: ReturnType<typeof usePlacesSearch>['view'];
  origin: PlanOrigin | null;
  onChangeText: (t: string) => void;
  onPick: ReturnType<typeof usePlacesSearch>['select'];
}) {
  const showList = origin === null && (view.status === 'results' || view.status === 'resolving');
  return (
    <View>
      <TextInput
        style={styles.input}
        value={origin?.source === 'gps' ? '' : view.query}
        onChangeText={onChangeText}
        placeholder={origin?.source === 'gps' ? 'Current location' : 'Search an address or place'}
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel="Starting point"
      />
      {view.status === 'searching' && <Text style={styles.hint}>Searching…</Text>}
      {view.status === 'empty' && <Text style={styles.hint}>No places found in this city.</Text>}
      {view.status === 'refine' && <Text style={styles.hint}>Pick a suggestion, or type a more specific address.</Text>}
      {view.status === 'error' && <Text style={styles.hint}>Search is unavailable right now. Use your current location instead.</Text>}
      {showList && (
        <View style={styles.suggestions}>
          {view.suggestions.map((s) => (
            <Pressable
              key={s.place_id}
              style={({ pressed }) => [styles.suggestion, pressed && styles.pressed]}
              onPress={() => onPick(s)}
              disabled={view.status === 'resolving'}
              accessibilityRole="button"
            >
              <Text style={styles.suggestionPrimary}>{s.primary}</Text>
              {s.secondary !== null && <Text style={styles.hint}>{s.secondary}</Text>}
            </Pressable>
          ))}
          {view.status === 'resolving' && <ActivityIndicator style={styles.resolving} />}
        </View>
      )}
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.h3}>{title}</Text>
      {children}
    </View>
  );
}

function ChipRow({ children }: { children: React.ReactNode }) {
  return <View style={styles.chips}>{children}</View>;
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.chip, selected && styles.chipOn]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
    >
      <Text style={[styles.chipText, selected && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 20, paddingBottom: 48 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  flex: { flex: 1 },
  eyebrow: { fontSize: 12, fontWeight: '700', letterSpacing: 0.8, color: colors.accent },
  section: { gap: 8 },
  h2: { fontSize: 17, fontWeight: '600', color: colors.ink },
  h3: { fontSize: 15, fontWeight: '600', color: colors.ink },
  muted: { fontSize: 14, color: colors.inkMuted, textAlign: 'center', lineHeight: 20 },
  hint: { fontSize: 13, color: colors.inkMuted, lineHeight: 18 },
  link: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  chosen: { fontSize: 14, fontWeight: '600', color: '#1B7A45' },
  input: {
    minHeight: MIN_TOUCH, borderWidth: 1, borderColor: colors.hairline, borderRadius: 10,
    paddingHorizontal: 12, fontSize: 16, color: colors.ink, backgroundColor: colors.canvas,
  },
  locate: { minHeight: MIN_TOUCH, justifyContent: 'center', alignSelf: 'flex-start' },
  suggestions: { marginTop: 4, borderWidth: 1, borderColor: colors.hairline, borderRadius: 10, overflow: 'hidden' },
  suggestion: { minHeight: MIN_TOUCH, paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline, gap: 2 },
  suggestionPrimary: { fontSize: 15, color: colors.ink },
  resolving: { padding: 10 },
  pressed: { backgroundColor: colors.surface },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: MIN_TOUCH, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 22, borderWidth: 1.5, borderColor: colors.hairline },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chipText: { fontSize: 14, color: colors.ink },
  chipTextOn: { fontWeight: '600', color: colors.accent },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  switchTitle: { fontSize: 15, fontWeight: '600', color: colors.ink },
  errorCard: { padding: 14, borderRadius: 12, backgroundColor: '#FBF0E0', gap: 4 },
  errorTitle: { fontSize: 15, fontWeight: '700', color: '#8A5A00' },
  errorText: { fontSize: 14, lineHeight: 19, color: '#6B4A12' },
  primary: { minHeight: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: colors.ink },
  primaryText: { color: colors.canvas, fontWeight: '600', fontSize: 16 },
  disabled: { opacity: 0.4 },
});
