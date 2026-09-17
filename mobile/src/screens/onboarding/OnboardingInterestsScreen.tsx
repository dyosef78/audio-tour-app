import { StyleSheet, View } from 'react-native';

import InterestBubble from '../../components/onboarding/InterestBubble';
import OnboardingScaffold from '../../components/onboarding/OnboardingScaffold';
import type { OnboardingInterestsScreenProps } from '../../navigation/types';
import { stepPosition } from '../../personalization/onboardingFlow';
import { INTERESTS, type Interest } from '../../personalization/options';
import { usePreferences } from '../../personalization/preferencesStore';
import { useReduceMotion } from '../../ui/useReduceMotion';

/** Culinary leads, full width (PM, Epic 11); the rest follow as a grid. */
const FEATURED: Interest = 'culinary';
const CULINARY_HIGHLIGHTS = ['🥙 Street food', '🧺 Markets', '🍷 Fine dining'] as const;

/** Onboarding - interests (TASK-601, bubbles since TASK-1101). Multiple choice, at least one. */
export default function OnboardingInterestsScreen({ navigation, route }: OnboardingInterestsScreenProps) {
  const editing = route.params?.editing === true;
  const includeCity = route.params?.includeCity === true;
  const interests = usePreferences((s) => s.interests);
  const toggleInterest = usePreferences((s) => s.toggleInterest);
  const reduceMotion = useReduceMotion();

  const { step, total } = stepPosition('OnboardingInterests', includeCity);
  const count = interests.length;
  const featured = INTERESTS.find((o) => o.id === FEATURED);
  const rest = INTERESTS.filter((o) => o.id !== FEATURED);

  return (
    <OnboardingScaffold
      step={step}
      totalSteps={total}
      title="What are you into?"
      subtitle="Pick as many as you like. We'll shape your route around them."
      back={{ label: 'Back', onPress: () => navigation.goBack() }}
      ctaLabel={count === 0 ? 'Choose at least one' : `Continue · ${count} selected`}
      ctaDisabled={count === 0}
      onCta={() => navigation.navigate('OnboardingTime', { editing, includeCity })}
    >
      {featured && (
        <InterestBubble
          option={featured}
          featured={{ highlights: CULINARY_HIGHLIGHTS }}
          selected={interests.includes(featured.id)}
          onPress={() => toggleInterest(featured.id)}
          reduceMotion={reduceMotion}
        />
      )}
      <View style={styles.grid}>
        {rest.map((option) => (
          <InterestBubble
            key={option.id}
            option={option}
            selected={interests.includes(option.id)}
            onPress={() => toggleInterest(option.id)}
            reduceMotion={reduceMotion}
          />
        ))}
      </View>
    </OnboardingScaffold>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
});
