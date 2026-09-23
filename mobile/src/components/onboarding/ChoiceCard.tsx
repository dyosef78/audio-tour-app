import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ChoiceOption } from '../../personalization/options';
import { colors } from '../../ui/theme';

interface Props {
  option: ChoiceOption<string>;
  selected: boolean;
  /** Checkbox semantics when true, radio when false - for screen readers and the indicator shape. */
  multi: boolean;
  onPress: () => void;
}

export default function ChoiceCard({ option, selected, multi, onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={multi ? 'checkbox' : 'radio'}
      accessibilityState={{ checked: selected }}
      accessibilityLabel={option.description ? `${option.label}. ${option.description}` : option.label}
      style={({ pressed }) => [styles.card, selected && styles.cardSelected, pressed && styles.cardPressed]}
    >
      <View style={[styles.icon, selected && styles.iconSelected]}>
        <Text style={styles.glyph}>{option.icon}</Text>
      </View>

      <View style={styles.text}>
        <Text style={styles.label}>{option.label}</Text>
        {option.description !== '' && <Text style={styles.description}>{option.description}</Text>}
      </View>

      <View style={[multi ? styles.check : styles.radio, selected && styles.indicatorOn]}>
        {selected && <Text style={styles.tick}>✓</Text>}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    minHeight: 76, paddingVertical: 12, paddingHorizontal: 14,
    borderRadius: 16, borderWidth: 1.5, borderColor: colors.hairline, backgroundColor: colors.canvas,
  },
  // Same border width in both states, so selecting never shifts the layout.
  cardSelected: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  cardPressed: { opacity: 0.75 },
  icon: {
    width: 48, height: 48, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface,
  },
  iconSelected: { backgroundColor: colors.canvas },
  glyph: { fontSize: 24 },
  text: { flex: 1 },
  label: { fontSize: 17, fontWeight: '600', color: colors.ink },
  description: { fontSize: 14, color: colors.inkSecondary, marginTop: 2 },
  radio: {
    width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: colors.hairline,
    alignItems: 'center', justifyContent: 'center',
  },
  check: {
    width: 24, height: 24, borderRadius: 7, borderWidth: 2, borderColor: colors.hairline,
    alignItems: 'center', justifyContent: 'center',
  },
  indicatorOn: { borderColor: colors.accent, backgroundColor: colors.accent },
  tick: { color: colors.canvas, fontSize: 14, fontWeight: '800', lineHeight: 16 },
});
