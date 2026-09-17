import { View } from 'react-native';

import ChoiceCard from '../../components/onboarding/ChoiceCard';
import OnboardingScaffold from '../../components/onboarding/OnboardingScaffold';
import type { OnboardingGroupScreenProps } from '../../navigation/types';
import { stepPosition } from '../../personalization/onboardingFlow';
import { GROUP_TYPES } from '../../personalization/options';
import { usePreferences } from '../../personalization/preferencesStore';

/** Onboarding - who is coming (TASK-601). Single choice. */
export default function OnboardingGroupScreen({ navigation, route }: OnboardingGroupScreenProps) {
  const editing = route.params?.editing === true;
  const includeCity = route.params?.includeCity === true;
  const groupType = usePreferences((s) => s.groupType);
  const setGroupType = usePreferences((s) => s.setGroupType);

  const { step, total } = stepPosition('OnboardingGroup', includeCity);

  // Close when editing; Back to City when this run has one; otherwise this is
  // the first numbered step and Welcome is not somewhere to return to.
  const back = editing
    ? { label: 'Close', onPress: () => navigation.goBack() }
    : includeCity
      ? { label: 'Back', onPress: () => navigation.goBack() }
      : undefined;

  return (
    <OnboardingScaffold
      step={step}
      totalSteps={total}
      title="Who's coming along?"
      subtitle="We'll use this to shape your route."
      back={back}
      ctaLabel="Continue"
      ctaDisabled={groupType === null}
      onCta={() => navigation.navigate('OnboardingInterests', { editing, includeCity })}
    >
      <View accessibilityRole="radiogroup" style={{ gap: 12 }}>
        {GROUP_TYPES.map((option) => (
          <ChoiceCard
            key={option.id}
            option={option}
            multi={false}
            selected={groupType === option.id}
            onPress={() => setGroupType(option.id)}
          />
        ))}
      </View>
    </OnboardingScaffold>
  );
}
