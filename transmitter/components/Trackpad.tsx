import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { createTrackpadGesture } from '../gestures/createTrackpadGesture';
import type { GestureInterpreter } from '../gestures/GestureInterpreter';
import type { InputEngine } from '../services/InputEngine';
import type { KeyboardController } from '../services/KeyboardController';
import { MessageType, type Button, type Direction } from '../../shared/protocol';
import { theme as t } from './theme';
import { InputPressable } from './InputPressable';

export function Trackpad({ interpreter, input, keyboard, connected, onConnect, compact }: {
  interpreter: GestureInterpreter; input: InputEngine; keyboard: KeyboardController; connected: boolean; onConnect: () => void; compact: boolean;
}) {
  const gesture = useMemo(() => createTrackpadGesture(interpreter), [interpreter]);
  const navigate = (direction: Direction) => {
    if (!connected) return;
    interpreter.reset();
    keyboard.shortcut(direction, ['control']);
  };
  const button = (name: string, which: Button, mark: string) => <InputPressable enabled={connected} accessibilityRole="button" accessibilityLabel={`${name}, hold to drag`}
    onDown={() => { input.send({ type: MessageType.mouse_down, button: which }); }}
    onUp={() => { input.send({ type: MessageType.mouse_up, button: which }); }}
    style={({ pressed }) => [s.mouseButton, compact && { height: 52 }, pressed && s.activeButton]}>
    <View style={s.buttonMain}><Text style={s.buttonMark}>{mark}</Text><Text style={s.buttonLabel}>{name}</Text></View><Text style={s.buttonHint}>HOLD TO DRAG</Text>
  </InputPressable>;
  return <View style={s.container}>
    <View style={s.pad}>
      <GestureDetector gesture={gesture}>
        <View collapsable={false} style={s.touchSurface} testID="touchpad">
        <View pointerEvents="none" style={s.padTop}><View style={s.miniLabel}><View style={[s.dot, !connected && { backgroundColor: t.dim }]} /><Text style={s.eyebrow}>TOUCH SURFACE</Text></View><Text style={s.padCorner}>01 / MOUSE</Text></View>
        <View pointerEvents="none" style={s.dots}>{Array.from({ length: 81 }, (_, i) => <View key={i} style={s.gridDot} />)}</View>
        <View pointerEvents={!connected && compact ? 'box-none' : 'none'} style={[s.center, compact && s.compactCenter]}>
          {!compact && <View style={s.cursorRing}><Text style={s.cursor}>↖</Text></View>}
          {!connected && compact ? <Pressable accessibilityRole="button" accessibilityLabel="Connect to a Mac" onPress={onConnect} style={s.inlineConnect}><Text style={s.connectText}>Connect to a Mac ↗</Text></Pressable> : <Text style={[s.padTitle, compact && { fontSize: 16 }]}>{connected ? 'Make your move.' : 'Your Mac, within reach.'}</Text>}
          {!compact && <Text style={s.padDescription}>{connected ? 'A little space. Complete control.' : 'Connect your Mac to get started.'}</Text>}
        </View>
        </View>
      </GestureDetector>
      {/* Keep buttons outside the touch recognizer so navigation never clicks the Mac. */}
      <View style={[s.padBottom, compact && s.compactPadBottom]}>
        {!compact && <View pointerEvents="none" style={s.gestureHints}><Text style={s.gestureHint}>ONE FINGER<Text style={s.hintValue}>  Move</Text></Text><Text style={s.gestureHint}>TWO FINGERS<Text style={s.hintValue}>  Scroll</Text></Text></View>}
        <View style={s.navigationButtons}>
          {([['left', '←'], ['right', '→'], ['up', '↑'], ['down', '↓']] as const).map(([direction, arrow]) => <Pressable
            key={direction} disabled={!connected} accessibilityRole="button" accessibilityLabel={`Navigate ${direction}`}
            accessibilityState={{ disabled: !connected }} testID={`navigate-${direction}`} onPress={() => navigate(direction)}
            style={({ pressed }) => [s.navigationButton, pressed && s.activeButton, !connected && s.disabledButton]}>
            <Text style={s.navigationArrow}>{arrow}</Text><Text style={s.navigationLabel}>{direction.toUpperCase()}</Text>
          </Pressable>)}
        </View>
      </View>
    </View>
    {!connected && !compact && <Pressable accessibilityRole="button" accessibilityLabel="Connect to a Mac" onPress={onConnect} style={s.connectOverlay}><Text style={s.connectText}>Connect to a Mac <Text style={{ fontSize: 17 }}>↗</Text></Text></Pressable>}
    <View style={s.buttons}>{button('Left click', 'left', '↖')}<Pressable disabled={!connected} accessibilityRole="button" accessibilityLabel="Double click" onPress={() => input.send({ type: MessageType.mouse_click, button: 'left', count: 2 })} style={({ pressed }) => [s.doubleButton, pressed && s.activeButton]}><Text style={s.doubleText}>×2</Text></Pressable>{button('Right click', 'right', '↗')}</View>
    {!compact && <Text style={s.footerHint}>Arrow buttons: desktops & overview · Pinch to zoom</Text>}
  </View>;
}
const s = StyleSheet.create({
  inlineConnect: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18, backgroundColor: t.accent },
  container: { flex: 1, gap: 12, minHeight: 160 }, pad: { flex: 1, minHeight: 140, borderRadius: 25, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface, overflow: 'hidden' },
  touchSurface: { flex: 1, minHeight: 0, overflow: 'hidden', justifyContent: 'center', alignItems: 'center' },
  padTop: { position: 'absolute', top: 21, left: 21, right: 21, flexDirection: 'row', justifyContent: 'space-between' }, miniLabel: { flexDirection: 'row', alignItems: 'center', gap: 7 }, dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: t.accent }, eyebrow: { color: t.muted, fontSize: 9, letterSpacing: 1.6, fontFamily: t.mono }, padCorner: { color: t.dim, fontSize: 9, fontFamily: t.mono },
  dots: { width: 234, height: 234, position: 'absolute', flexDirection: 'row', flexWrap: 'wrap', opacity: 0.34 }, gridDot: { width: 2, height: 2, borderRadius: 1, backgroundColor: t.dim, margin: 12 },
  center: { alignItems: 'center', gap: 12, padding: 28 }, compactCenter: { padding: 10, paddingTop: 42, gap: 0 }, cursorRing: { height: 72, width: 72, borderRadius: 24, backgroundColor: t.bg, borderWidth: 1, borderColor: t.border, alignItems: 'center', justifyContent: 'center', marginBottom: 5 }, cursor: { color: t.accent, fontSize: 40, fontWeight: '200' }, padTitle: { color: t.text, fontSize: 21, letterSpacing: -0.5, fontWeight: '500', textAlign: 'center' }, padDescription: { color: t.muted, fontSize: 12, textAlign: 'center' },
  padBottom: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 14, gap: 12, borderTopWidth: 1, borderTopColor: t.border }, compactPadBottom: { paddingTop: 7, paddingBottom: 8 }, gestureHints: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 }, gestureHint: { color: t.dim, fontFamily: t.mono, fontSize: 8, letterSpacing: 0.5 }, hintValue: { color: t.muted, fontFamily: undefined, fontSize: 10 },
  navigationButtons: { flexDirection: 'row', gap: 8 }, navigationButton: { flex: 1, minHeight: 48, borderRadius: 12, backgroundColor: t.raised, borderWidth: 1, borderColor: t.border, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5 }, navigationArrow: { color: t.accent, fontSize: 22 }, navigationLabel: { color: t.muted, fontSize: 8, fontFamily: t.mono, letterSpacing: 0.3 }, disabledButton: { opacity: 0.35 },
  buttons: { flexDirection: 'row', gap: 9 }, mouseButton: { flex: 1, height: 70, borderRadius: 17, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, alignItems: 'center', justifyContent: 'center', gap: 7 }, buttonMain: { flexDirection: 'row', alignItems: 'center', gap: 8 }, activeButton: { backgroundColor: t.accentDark, borderColor: t.accent }, buttonMark: { fontSize: 18, color: t.accent }, buttonLabel: { fontSize: 13, color: t.text, fontWeight: '500' }, buttonHint: { textAlign: 'center', color: t.dim, fontSize: 7, fontFamily: t.mono, letterSpacing: 1.3 },
  doubleButton: { width: 47, borderRadius: 17, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, justifyContent: 'center', alignItems: 'center' }, doubleText: { color: t.muted, fontSize: 14, fontFamily: t.mono },
  footerHint: { color: t.dim, fontSize: 11, textAlign: 'center', marginTop: 2 }, connectOverlay: { position: 'absolute', top: '65%', alignSelf: 'center', paddingHorizontal: 19, paddingVertical: 11, borderRadius: 20, backgroundColor: t.accent }, connectText: { color: t.bg, fontSize: 12, fontWeight: '600' },
});
