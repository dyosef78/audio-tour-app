import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import ChoiceCard from '../../components/onboarding/ChoiceCard';
import OnboardingScaffold from '../../components/onboarding/OnboardingScaffold';
import type { OnboardingCityScreenProps } from '../../navigation/types';
import { refreshCities, useCityCatalogue } from '../../personalization/cityCatalogue';
import { stepPosition } from '../../personalization/onboardingFlow';
import { usePreferences } from '../../personalization/preferencesStore';
import { colors } from '../../ui/theme';

/**
 * Onboarding - which city (TASK-1101). Single choice.
 *
 * Only reached when there are two or more cities; with one, it is chosen
 * silently. Also opened on its own from Discovery (`editing`) to switch city.
 * The offline bundle is NOT fetched here - that stays per tour, on Tour Detail.
 */
export default function OnboardingCityScreen({ navigation, route }: OnboardingCityScreenProps) {
  const editing = route.params?.editing === true;
  const cities = useCityCatalogue((s) => s.cities);
  const cityId = usePreferences((s) => s.cityId);
  const setCity = usePreferences((s) => s.setCity);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    void refreshCities();
  }, []);

  const { step, total } = editing ? { step: 1, total: 1 } : stepPosition('OnboardingCity', true);
  const chosen = cityId !== null && (cities ?? []).some((c) => c.id === cityId);

  const retry = async () => {
    setRetrying(true);
    await refreshCities();
    setRetrying(false);
  };

  return (
    <OnboardingScaffold
      step={step}
      totalSteps={total}
      title="Where are you exploring?"
      subtitle="We'll show you the tours in that city."
      back={editing ? { label: 'Close', onPress: () => navigation.goBack() } : undefined}
      ctaLabel={editing ? 'Done' : 'Continue'}
      ctaDisabled={!chosen}
      onCta={() =>
        editing ? navigation.goBack() : navigation.navigate('OnboardingGroup', { includeCity: true })
      }
    >
      {cities === null || cities.length === 0 ? (
        <View style={styles.empty}>
          {retrying ? (
            <ActivityIndicator />
          ) : (
            <>
              <Text style={styles.emptyText}>Cities couldn't be loaded. Check your connection.</Text>
              <Pressable onPress={() => void retry()} accessibilityRole="button" style={styles.retry}>
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </>
          )}
        </View>
      ) : (
        <View accessibilityRole="radiogroup" style={{ gap: 12 }}>
          {cities.map((city) => (
            <ChoiceCard
              key={city.id}
              option={{ id: city.id, label: city.name, description: '', icon: '📍' }}
              multi={false}
              selected={cityId === city.id}
              onPress={() => setCity(city.id)}
            />
          ))}
        </View>
      )}
    </OnboardingScaffold>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', gap: 12, paddingVertical: 32 },
  emptyText: { fontSize: 15, color: colors.inkMuted, textAlign: 'center' },
  retry: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 20 },
  retryText: { fontSize: 16, fontWeight: '600', color: colors.accent },
});
