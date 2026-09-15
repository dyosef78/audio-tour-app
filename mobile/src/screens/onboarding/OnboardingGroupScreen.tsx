import { View } from 'react-native';

import ChoiceCard from '../../components/onboarding/ChoiceCard';
import OnboardingScaffold from '../../components/onboarding/OnboardingScaffold';
import type { OnboardingGroupScreenProps } from '../../navigation/types';
import { GROUP_TYPES } from '../../personalization/options';
import { usePreferences } from '../../personalization/preferencesStore';

/** Onboarding 1/3 - who is coming (TASK-601). Single choice. */
export default function OnboardingGroupScreen({ navigation, route }: OnboardingGroupScreenProps) {
  const editing = route.params?.editing === true;
  const groupType = usePreferences((s) => s.groupType);
  const setGroupType = usePreferences((s) => s.setGroupType);

  return (
    <OnboardingScaffold
      step={1}
      title="Who's coming along?"
      subtitle="We'll use this to shape your route."
      back={editing ? { label: 'Close', onPress: () => navigation.goBack() } : undefined}
      ctaLabel="Continue"
      ctaDisabled={groupType === null}
      onCta={() => navigation.navigate('OnboardingInterests', { editing })}
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
