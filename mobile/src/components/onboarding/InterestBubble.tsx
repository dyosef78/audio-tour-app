import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import type { ChoiceOption, Interest } from '../../personalization/options';
import { INTEREST_TINTS } from '../../ui/interestTints';
import { colors } from '../../ui/theme';

/**
 * One interest on the Interests step (TASK-1101): a tinted bubble rather than
 * a row, so the screen reads as a set of things to be into, not a form.
 *
 * `featured` is the full-width Culinary bubble. Its highlights are how the PM's
 * street food / markets / fine dining brief is shown WITHOUT becoming tags: they
 * describe the single `culinary` id and are hidden from screen readers, which
 * already hear the description.
 *
 * Motion is a small press-in and a pop on select, both skipped under Reduce
 * Motion. Native driver only; nothing here animates layout.
 */

interface Props {
  option: ChoiceOption<Interest>;
  selected: boolean;
  onPress: () => void;
  reduceMotion: boolean;
  featured?: { highlights: readonly string[] };
}

export default function InterestBubble({ option, selected, onPress, reduceMotion, featured }: Props) {
  const tint = INTEREST_TINTS[option.id];
  const scale = useRef(new Animated.Value(1)).current;
  const first = useRef(true);

  useEffect(() => {
    // No pop on mount: a returning visitor's saved picks should just be there.
    if (first.current) {
      first.current = false;
      return;
    }
    if (reduceMotion || !selected) return;
    scale.setValue(0.94);
    Animated.spring(scale, { toValue: 1, friction: 4, tension: 160, useNativeDriver: true }).start();
  }, [selected, reduceMotion, scale]);

  const press = (toValue: number) => {
    if (reduceMotion) return;
    Animated.spring(scale, { toValue, friction: 7, tension: 220, useNativeDriver: true }).start();
  };

  return (
    <Animated.View style={[featured ? styles.featuredWrap : styles.wrap, { transform: [{ scale }] }]}>
      <Pressable
        onPress={onPress}
        onPressIn={() => press(0.97)}
        onPressOut={() => press(1)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: selected }}
        accessibilityLabel={`${option.label}. ${option.description}`}
        style={[
          styles.bubble,
          featured && styles.featured,
          selected ? { backgroundColor: tint.soft, borderColor: tint.strong } : styles.idle,
        ]}
      >
        <View style={[styles.glyphDisc, featured && styles.glyphDiscFeatured, { backgroundColor: selected ? colors.canvas : tint.soft }]}>
          <Text style={[styles.glyph, featured && styles.glyphFeatured]}>{option.icon}</Text>
        </View>

        <View style={featured ? styles.featuredText : styles.text}>
          <Text style={[styles.label, featured && styles.labelFeatured]}>{option.label}</Text>
          <Text style={styles.description} numberOfLines={featured ? 2 : 3}>
            {option.description}
          </Text>
          {featured && (
            <View style={styles.highlights} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
              {featured.highlights.map((h) => (
                <Text key={h} style={[styles.highlight, { color: tint.strong, borderColor: selected ? tint.strong : tint.soft }]}>
                  {h}
                </Text>
              ))}
            </View>
          )}
        </View>

        <View style={[styles.check, selected && { backgroundColor: tint.strong, borderColor: tint.strong }]}>
          {selected && <Text style={styles.tick}>✓</Text>}
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Two per row on a phone; one per row once large text makes 150 pt too narrow.
  wrap: { flexBasis: '46%', flexGrow: 1, minWidth: 150 },
  featuredWrap: { width: '100%' },

  bubble: {
    minHeight: 132, borderRadius: 24, borderWidth: 2, padding: 14, gap: 10,
  },
  // Same border width in both states, so selecting never shifts the layout.
  idle: { backgroundColor: colors.canvas, borderColor: colors.hairline },
  featured: { flexDirection: 'row', alignItems: 'center', minHeight: 120, gap: 14, paddingVertical: 18 },

  glyphDisc: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  glyphDiscFeatured: { width: 64, height: 64, borderRadius: 32 },
  glyph: { fontSize: 24 },
  glyphFeatured: { fontSize: 34 },

  text: { gap: 2, paddingRight: 22 },
  featuredText: { flex: 1, gap: 3 },
  label: { fontSize: 17, fontWeight: '700', color: colors.ink },
  labelFeatured: { fontSize: 20 },
  description: { fontSize: 13, lineHeight: 18, color: colors.inkSecondary },

  highlights: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  highlight: {
    fontSize: 12, fontWeight: '600', overflow: 'hidden',
    paddingVertical: 3, paddingHorizontal: 8, borderRadius: 999, borderWidth: 1, backgroundColor: colors.canvas,
  },

  check: {
    position: 'absolute', top: 12, right: 12,
    width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: colors.hairline,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas,
  },
  tick: { color: colors.canvas, fontSize: 13, fontWeight: '800', lineHeight: 15 },
});
