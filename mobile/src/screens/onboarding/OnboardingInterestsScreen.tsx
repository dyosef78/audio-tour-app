import ChoiceCard from '../../components/onboarding/ChoiceCard';
import OnboardingScaffold from '../../components/onboarding/OnboardingScaffold';
import type { OnboardingInterestsScreenProps } from '../../navigation/types';
import { INTERESTS } from '../../personalization/options';
import { usePreferences } from '../../personalization/preferencesStore';

/** Onboarding 2/3 - interests (TASK-601). Multiple choice, at least one. */
export default function OnboardingInterestsScreen({ navigation, route }: OnboardingInterestsScreenProps) {
  const editing = route.params?.editing === true;
  const interests = usePreferences((s) => s.interests);
  const toggleInterest = usePreferences((s) => s.toggleInterest);

  const count = interests.length;

  return (
    <OnboardingScaffold
      step={2}
      title="What are you into?"
      subtitle="Pick as many as you like."
      back={{ label: 'Back', onPress: () => navigation.goBack() }}
      ctaLabel={count === 0 ? 'Choose at least one' : `Continue · ${count} selected`}
      ctaDisabled={count === 0}
      onCta={() => navigation.navigate('OnboardingTime', { editing })}
    >
      {INTERESTS.map((option) => (
        <ChoiceCard
          key={option.id}
          option={option}
          multi
          selected={interests.includes(option.id)}
          onPress={() => toggleInterest(option.id)}
        />
      ))}
    </OnboardingScaffold>
  );
}
