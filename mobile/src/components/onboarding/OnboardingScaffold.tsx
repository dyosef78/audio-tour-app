import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, MIN_TOUCH } from '../../ui/theme';

export const ONBOARDING_STEPS = 3;

interface Props {
  step: number;
  title: string;
  subtitle: string;
  /** Omitted on the very first screen of a first run: there is nowhere to go back to. */
  back?: { label: string; onPress: () => void };
  ctaLabel: string;
  ctaDisabled: boolean;
  onCta: () => void;
  children: ReactNode;
}

/**
 * Shared frame for the three onboarding steps: progress, a scrolling body of
 * choices, and a primary action pinned above the home indicator so it never
 * scrolls out of reach on a small phone with large text.
 */
export default function OnboardingScaffold({
  step,
  title,
  subtitle,
  back,
  ctaLabel,
  ctaDisabled,
  onCta,
  children,
}: Props) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, { paddingTop: insets.top + 6 }]}>
      <View style={styles.topBar}>
        <View style={styles.side}>
          {back && (
            <Pressable onPress={back.onPress} hitSlop={10} accessibilityRole="button" style={styles.backHit}>
              <Text style={styles.backText}>{back.label}</Text>
            </Pressable>
          )}
        </View>
        <View
          style={styles.progress}
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={`Step ${step} of ${ONBOARDING_STEPS}`}
        >
          {Array.from({ length: ONBOARDING_STEPS }, (_, i) => (
            <View key={i} style={[styles.segment, i < step && styles.segmentDone]} />
          ))}
        </View>
        <View style={styles.side} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* The progress bar already announces the step to screen readers. */}
        <Text style={styles.eyebrow} importantForAccessibility="no" accessibilityElementsHidden>
          STEP {step} OF {ONBOARDING_STEPS}
        </Text>
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
        <View style={styles.choices}>{children}</View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 14 }]}>
        <Pressable
          onPress={onCta}
          disabled={ctaDisabled}
          accessibilityRole="button"
          accessibilityState={{ disabled: ctaDisabled }}
          style={({ pressed }) => [
            styles.cta,
            ctaDisabled && styles.ctaDisabled,
            pressed && !ctaDisabled && styles.ctaPressed,
          ]}
        >
          <Text style={[styles.ctaText, ctaDisabled && styles.ctaTextDisabled]}>{ctaLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, height: MIN_TOUCH },
  side: { width: 64 },
  backHit: { minHeight: MIN_TOUCH, justifyContent: 'center' },
  backText: { fontSize: 16, color: colors.accent, fontWeight: '600' },
  progress: { flex: 1, flexDirection: 'row', gap: 6 },
  segment: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.hairline },
  segmentDone: { backgroundColor: colors.accent },

  content: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 24 },
  eyebrow: { fontSize: 12, fontWeight: '700', letterSpacing: 1, color: colors.accent },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700', color: colors.ink, marginTop: 6 },
  subtitle: { fontSize: 16, lineHeight: 22, color: colors.inkMuted, marginTop: 8 },
  choices: { marginTop: 24, gap: 12 },

  footer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.hairline,
    backgroundColor: colors.canvas,
  },
  cta: {
    minHeight: 54, borderRadius: 14, backgroundColor: colors.ink,
    alignItems: 'center', justifyContent: 'center',
  },
  ctaPressed: { opacity: 0.85 },
  ctaDisabled: { backgroundColor: colors.surface },
  ctaText: { color: colors.canvas, fontSize: 17, fontWeight: '700' },
  ctaTextDisabled: { color: colors.inkMuted },
});
