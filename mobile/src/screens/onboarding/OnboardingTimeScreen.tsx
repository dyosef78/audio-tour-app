import { View } from 'react-native';

import ChoiceCard from '../../components/onboarding/ChoiceCard';
import OnboardingScaffold from '../../components/onboarding/OnboardingScaffold';
import type { OnboardingTimeScreenProps } from '../../navigation/types';
import { stepPosition } from '../../personalization/onboardingFlow';
import { TIME_BUDGETS } from '../../personalization/options';
import { usePreferences } from '../../personalization/preferencesStore';

/** Onboarding - time available (TASK-601). Single choice; finishing lands on Discovery. */
export default function OnboardingTimeScreen({ navigation, route }: OnboardingTimeScreenProps) {
  const editing = route.params?.editing === true;
  const { step, total } = stepPosition('OnboardingTime', route.params?.includeCity === true);
  const timeBudget = usePreferences((s) => s.timeBudget);
  const setTimeBudget = usePreferences((s) => s.setTimeBudget);
  const completeOnboarding = usePreferences((s) => s.completeOnboarding);

  const finish = (): void => {
    completeOnboarding();
    // Reset rather than navigate, so back from Discovery cannot re-enter
    // onboarding, and the edit flow does not stack a second Discovery.
    navigation.reset({ index: 0, routes: [{ name: 'Discovery' }] });
  };

  return (
    <OnboardingScaffold
      step={step}
      totalSteps={total}
      title="How much time do you have?"
      subtitle="We'll put the tours that fit first. You can change this any time."
      back={{ label: 'Back', onPress: () => navigation.goBack() }}
      ctaLabel={editing ? 'Save preferences' : 'Start exploring'}
      ctaDisabled={timeBudget === null}
      onCta={finish}
    >
      <View accessibilityRole="radiogroup" style={{ gap: 12 }}>
        {TIME_BUDGETS.map((option) => (
          <ChoiceCard
            key={option.id}
            option={option}
            multi={false}
            selected={timeBudget === option.id}
            onPress={() => setTimeBudget(option.id)}
          />
        ))}
      </View>
    </OnboardingScaffold>
  );
}
