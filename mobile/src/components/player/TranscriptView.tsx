import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import { useTourSession } from '../../session/tourSessionStore';
import { TranscriptRepository } from '../../transcript/TranscriptRepository';
import { cueIndexAt, isRtlText, type Cue } from '../../transcript/vtt';
import type { AudioTrack } from '../../types/domain';
import { colors, MIN_TOUCH } from '../../ui/theme';

/**
 * Compensates for status-feed lag.
 *
 * expo-audio reports position every 500 ms by default, so the stored position
 * is on average ~250 ms behind the audio. Leading by half the interval centres
 * the error around zero instead of always highlighting late. Raising the update
 * rate instead would multiply store writes for every subscriber.
 */
const LOOKAHEAD_SECONDS = 0.25;

/** Keeps the current line a little below the top edge, with the previous line in view. */
const SCROLL_CONTEXT_PX = 64;

interface Props {
  tourId: string;
  track: AudioTrack;
  reduceMotion: boolean;
  onSeek: (seconds: number) => void;
}

/**
 * Karaoke-style synchronised transcript (TASK-602).
 *
 * ACCESSIBILITY NOTE - deliberately NOT a live region. The narration is already
 * speaking; a screen reader announcing each new line would talk over it. The
 * transcript exists for people who cannot hear the audio, and for them the
 * visual highlight is the signal. Every line is still a focusable button.
 */
export default function TranscriptView({ tourId, track, reduceMotion, onSeek }: Props) {
  const load = useMemo(() => TranscriptRepository.load(tourId, track), [tourId, track]);

  if (load.status === 'missing') {
    return <Text style={styles.empty}>No transcript is available for this stop yet.</Text>;
  }
  if (load.status === 'invalid') {
    return <Text style={styles.empty}>Transcript unavailable: {load.message}</Text>;
  }
  return (
    <CueList cues={load.cues} devSample={load.source === 'dev-sample'} reduceMotion={reduceMotion} onSeek={onSeek} />
  );
}

function CueList({
  cues,
  devSample,
  reduceMotion,
  onSeek,
}: {
  cues: Cue[];
  devSample: boolean;
  reduceMotion: boolean;
  onSeek: (seconds: number) => void;
}) {
  // Selecting the INDEX, not the position: this re-renders when the highlighted
  // line changes, not on every half-second status tick.
  const active = useTourSession((s) => cueIndexAt(cues, s.positionSeconds + LOOKAHEAD_SECONDS));

  const rtl = useMemo(() => cues.map((c) => isRtlText(c.text)), [cues]);
  const scrollRef = useRef<ScrollView>(null);
  const offsets = useRef<number[]>([]);
  // True once the user scrolls by hand; auto-follow pauses until they ask for it back.
  const [browsing, setBrowsing] = useState(false);

  const scrollToActive = useCallback(
    (animated: boolean) => {
      const y = active < 0 ? 0 : offsets.current[active];
      if (y === undefined) return;
      scrollRef.current?.scrollTo({ y: Math.max(0, y - SCROLL_CONTEXT_PX), animated });
    },
    [active],
  );

  useEffect(() => {
    if (!browsing) scrollToActive(!reduceMotion);
  }, [active, browsing, reduceMotion, scrollToActive]);

  const onRowLayout = useCallback((index: number, e: LayoutChangeEvent) => {
    offsets.current[index] = e.nativeEvent.layout.y;
  }, []);

  const onRowPress = useCallback(
    (index: number) => {
      const cue = cues[index];
      if (!cue) return;
      setBrowsing(false);
      onSeek(cue.start);
    },
    [cues, onSeek],
  );

  return (
    <View style={styles.root}>
      {devSample && (
        <Text style={styles.devBadge} accessibilityLabel="Development sample transcript, not the real narration">
          DEV SAMPLE · not the real narration
        </Text>
      )}

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.content}
        onScrollBeginDrag={() => setBrowsing(true)}
        // Row offsets only exist after layout, so the first follow happens here.
        onContentSizeChange={() => {
          if (!browsing) scrollToActive(false);
        }}
      >
        {cues.map((cue, i) => (
          <CueRow
            key={`${cue.start}:${i}`}
            index={i}
            text={cue.text}
            rtl={rtl[i] === true}
            state={i === active ? 'active' : i < active ? 'past' : 'upcoming'}
            onPress={onRowPress}
            onLayout={onRowLayout}
          />
        ))}
      </ScrollView>

      {browsing && (
        <Pressable
          style={styles.resume}
          onPress={() => setBrowsing(false)}
          accessibilityRole="button"
          accessibilityLabel="Return to the line being narrated"
        >
          <Text style={styles.resumeText}>↓ Current line</Text>
        </Pressable>
      )}
    </View>
  );
}

type CueState = 'past' | 'active' | 'upcoming';

/**
 * Memoised so a highlight change re-renders two rows, not the whole transcript.
 *
 * Active and inactive rows share font size and weight: only colour and
 * background change. Anything that alters line wrapping would move every row
 * below it and make the auto-scroll target jump.
 */
const CueRow = memo(function CueRow({
  index,
  text,
  rtl,
  state,
  onPress,
  onLayout,
}: {
  index: number;
  text: string;
  rtl: boolean;
  state: CueState;
  onPress: (index: number) => void;
  onLayout: (index: number, e: LayoutChangeEvent) => void;
}) {
  return (
    <Pressable
      onPress={() => onPress(index)}
      onLayout={(e) => onLayout(index, e)}
      accessibilityRole="button"
      accessibilityLabel={text}
      accessibilityHint="Plays the narration from this line"
      accessibilityState={{ selected: state === 'active' }}
      style={[styles.row, state === 'active' && styles.rowActive]}
    >
      <Text
        style={[
          styles.line,
          state === 'past' && styles.linePast,
          state === 'active' && styles.lineActive,
          rtl ? styles.rtl : styles.ltr,
        ]}
      >
        {text}
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: 96 },
  empty: { color: colors.onSheetMuted, fontSize: 15, lineHeight: 22, paddingVertical: 12 },
  devBadge: {
    alignSelf: 'flex-start', marginBottom: 8, overflow: 'hidden',
    paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6,
    fontSize: 11, fontWeight: '700', letterSpacing: 0.5,
    color: '#1C1C1E', backgroundColor: '#FFD60A',
  },
  row: { minHeight: MIN_TOUCH, justifyContent: 'center', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12 },
  rowActive: { backgroundColor: 'rgba(52,199,89,0.16)' },
  line: { fontSize: 19, lineHeight: 28, fontWeight: '600', color: colors.onSheetMuted },
  linePast: { color: colors.onSheetFaint },
  lineActive: { color: colors.onSheet },
  ltr: { textAlign: 'left', writingDirection: 'ltr' },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  resume: {
    position: 'absolute', alignSelf: 'center', bottom: 12,
    minHeight: MIN_TOUCH, justifyContent: 'center',
    paddingHorizontal: 18, borderRadius: 22, backgroundColor: colors.onSheet,
  },
  resumeText: { color: colors.ink, fontSize: 14, fontWeight: '700' },
});
