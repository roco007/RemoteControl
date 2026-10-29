import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type { ClientPayload } from '../../shared/protocol';
import { SoundLightController, type SoundLightMode } from '../services/SoundLightController';
import { theme as t } from './theme';

type Props = {
  connected: boolean;
  supported: boolean;
  session: string;
  paused: boolean;
  send: (payload: ClientPayload) => boolean;
  onConnect: () => void;
  haptic: () => void;
};

export function SoundLightPanel(props: Props) {
  const [mode, setMode] = useState<SoundLightMode>('volume');
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [feedback, setFeedback] = useState({ steps: 0, moving: false, direction: 0 });
  const latest = useRef(props); latest.current = props;
  const controller = useMemo(() => new SoundLightController({
    send: payload => latest.current.send(payload),
    enabled: () => latest.current.connected && latest.current.supported && !latest.current.paused,
    session: () => latest.current.session,
  }), []);
  const enabled = props.connected && props.supported && !props.paused;
  const tiny = size.height < 260;
  const small = size.height < 420;
  const buttonSize = tiny ? 64 : small ? 86 : 110;
  const radius = Math.max(buttonSize / 2 + 10, Math.min(size.width / 2 - 24, size.height / 2 - (tiny ? 32 : small ? 76 : 116)));
  const center = { x: size.width / 2, y: size.height / 2 };

  useEffect(() => {
    controller.reset(); setFeedback({ steps: 0, moving: false, direction: 0 });
  }, [controller, enabled, props.session, mode, size.width, size.height]);
  useEffect(() => {
    const reset = () => { controller.reset(); setFeedback(current => ({ ...current, moving: false })); };
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') reset(); });
    if (Platform.OS === 'web') globalThis.addEventListener?.('blur', reset);
    return () => { controller.reset(); subscription.remove(); if (Platform.OS === 'web') globalThis.removeEventListener?.('blur', reset); };
  }, [controller]);

  const gesture = useMemo(() => Gesture.Pan().minPointers(1).maxPointers(1).minDistance(2).runOnJS(true).enabled(enabled)
    .onBegin(event => {
      controller.begin({ x: event.x, y: event.y }, { x: size.width / 2, y: size.height / 2 }, buttonSize / 2 + 8, mode);
      setFeedback({ steps: 0, moving: false, direction: 0 });
    })
    .onTouchesDown(event => { if (event.numberOfTouches > 1) controller.reset(); })
    .onTouchesCancelled(() => controller.reset())
    .onUpdate(event => {
      const steps = controller.move({ x: event.x, y: event.y }, event.numberOfPointers);
      if (steps) setFeedback(current => ({ steps: current.steps + steps, moving: true, direction: Math.sign(steps) }));
    })
    .onFinalize(() => { controller.reset(); setFeedback(current => ({ ...current, moving: false })); }),
  [controller, enabled, mode, size.width, size.height, buttonSize]);

  const toggleMode = () => { controller.reset(); setMode(current => current === 'volume' ? 'brightness' : 'volume'); props.haptic(); };
  const label = mode === 'volume' ? 'Sound' : 'Light';
  const direction = feedback.direction > 0 ? 'CLOCKWISE · INCREASE' : 'ANTICLOCKWISE · DECREASE';
  const status = !props.connected ? 'Connect to your Mac to start.' : !props.supported ? 'Update the Mac receiver to use Sound & Light.' :
    'Draw around the centre. The further you turn, the more it changes.';

  return <View style={s.container}>
    <View style={s.surface} onLayout={event => {
      const { width, height } = event.nativeEvent.layout;
      setSize({ width, height });
    }}>
      <GestureDetector gesture={gesture}>
        <View style={StyleSheet.absoluteFill} collapsable={false} testID="sound-light-surface">
          <View pointerEvents="none" style={s.topRow}><Text style={s.eyebrow}>{mode === 'volume' ? 'MAC VOLUME' : 'MAC BRIGHTNESS'}</Text><Text style={s.sectionNumber}>04 / SOUND & LIGHT</Text></View>
          {!tiny && <View pointerEvents="none" style={[s.feedback, small && { top: 41 }]}>
            <Text style={[s.feedbackTitle, small && { fontSize: 16 }]}>{feedback.steps ? `${feedback.steps > 0 ? '+' : '−'}${Math.round(Math.abs(feedback.steps) * 360 / 64)}°` : 'Give it a spin.'}</Text>
            {!small && <Text style={s.feedbackCaption}>{feedback.steps ? direction : 'A CIRCULAR REMOTE FOR YOUR MAC'}</Text>}
          </View>}
          <View pointerEvents="none" style={[s.orbit, { width: radius * 2, height: radius * 2, borderRadius: radius, left: center.x - radius, top: center.y - radius, opacity: enabled ? 1 : 0.4 }]} />
          {Array.from({ length: 48 }, (_, i) => {
            const angle = i * Math.PI * 2 / 48 - Math.PI / 2;
            const active = feedback.moving && (feedback.direction > 0 ? i : (48 - i) % 48) < Math.min(48, Math.abs(feedback.steps) * 48 / 64);
            return <View key={i} pointerEvents="none" style={[s.tick, {
              left: center.x + Math.cos(angle) * (radius - 10) - 1,
              top: center.y + Math.sin(angle) * (radius - 10) - 3,
              backgroundColor: active ? t.accent : t.border,
              transform: [{ rotate: `${i * 360 / 48}deg` }],
            }]} />;
          })}
          {!tiny && <View pointerEvents="none" style={[s.directionHints, small && { bottom: 16 }]}>
            <View style={s.directionHint}><Text style={s.directionArrow}>↶</Text><Text style={s.directionText}>LESS</Text></View>
            <Text style={s.surfaceHint}>CIRCLE ANYWHERE AROUND THE BUTTON</Text>
            <View style={s.directionHint}><Text style={s.directionArrow}>↷</Text><Text style={s.directionText}>MORE</Text></View>
          </View>}
        </View>
      </GestureDetector>
      {/* A sibling button owns its touches, so a toggle never adjusts a level. */}
      <View pointerEvents="box-none" style={s.toggleLayer}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${label} selected. Switch to ${mode === 'volume' ? 'Light' : 'Sound'}`}
          accessibilityHint="Tap to choose which Mac control circular gestures adjust" testID="sound-light-toggle" onPress={toggleMode}
          style={({ pressed }) => [s.toggle, { width: buttonSize, height: buttonSize, borderRadius: buttonSize / 2 }, pressed && s.togglePressed]}>
          <Text style={[s.modeIcon, small && { fontSize: 24 }, tiny && { fontSize: 21, lineHeight: 23 }]}>{mode === 'volume' ? '♪' : '☼'}</Text>
          <Text style={[s.modeLabel, tiny && { fontSize: 12 }]}>{label}</Text>
          {!tiny && <Text style={s.modeHint}>TAP TO SWITCH</Text>}
        </Pressable>
      </View>
    </View>
    {!props.connected ? <Pressable accessibilityRole="button" onPress={props.onConnect} style={s.connect}><Text style={s.connectText}>Connect to your Mac ↗</Text></Pressable> : <Text style={[s.help, !props.supported && { color: t.warning }]}>{status}</Text>}
  </View>;
}

const s = StyleSheet.create({
  container: { flex: 1, gap: 12, minHeight: 0 },
  surface: { flex: 1, borderWidth: 1, borderColor: t.border, borderRadius: 25, backgroundColor: t.surface, overflow: 'hidden' },
  topRow: { position: 'absolute', top: 21, left: 20, right: 20, flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  eyebrow: { color: t.muted, fontFamily: t.mono, fontSize: 9, letterSpacing: 1.3 },
  sectionNumber: { color: t.dim, fontFamily: t.mono, fontSize: 8 },
  feedback: { position: 'absolute', top: 63, left: 15, right: 15, alignItems: 'center', gap: 8 },
  feedbackTitle: { color: t.text, fontSize: 25, fontWeight: '400', letterSpacing: -0.6 },
  feedbackCaption: { color: t.dim, fontFamily: t.mono, fontSize: 8, letterSpacing: 1 },
  orbit: { position: 'absolute', borderWidth: 1, borderColor: t.border },
  tick: { position: 'absolute', width: 2, height: 6, borderRadius: 1 },
  toggleLayer: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  toggle: { backgroundColor: t.accent, borderWidth: 1, borderColor: t.accent, alignItems: 'center', justifyContent: 'center', gap: 3 },
  togglePressed: { backgroundColor: '#a9db72', transform: [{ scale: 0.96 }] },
  modeIcon: { color: t.bg, fontSize: 34, lineHeight: 35 },
  modeLabel: { color: t.bg, fontSize: 15, fontWeight: '600' },
  modeHint: { color: t.accentDark, fontFamily: t.mono, fontSize: 6, letterSpacing: 0.6, marginTop: 3 },
  directionHints: { position: 'absolute', bottom: 26, left: 22, right: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  directionHint: { alignItems: 'center', gap: 3 },
  directionArrow: { color: t.muted, fontSize: 25 },
  directionText: { color: t.muted, fontSize: 7, fontFamily: t.mono, letterSpacing: 1.3 },
  surfaceHint: { color: t.dim, fontSize: 7, fontFamily: t.mono, textAlign: 'center', flexShrink: 1, maxWidth: 155, lineHeight: 13, letterSpacing: 0.6 },
  help: { color: t.muted, fontSize: 11, lineHeight: 17, textAlign: 'center', paddingHorizontal: 8 },
  connect: { alignSelf: 'center', backgroundColor: t.accent, paddingHorizontal: 18, paddingVertical: 11, borderRadius: 20 },
  connectText: { color: t.bg, fontWeight: '600', fontSize: 12 },
});
