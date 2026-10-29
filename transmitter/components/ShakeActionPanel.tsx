import React from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { defaultGestureOrders, gestureMappingName, gestureNames, gesturesForMode, type GestureKey, type GestureMappings, type GestureMode, type GestureOrders } from '../services/gestureSettings';
import { theme as t } from './theme';

export function ShakeActionPanel({ enabled, onToggle, onConfigure, onRun, busy = false, activeGesture = null, onCalibrate, calibrationSummary, calibrated, status, listening, count, lastCount, lastGesture, mode, mappings, orders, compact, dense, onResume, resuming }: {
  activeGesture?: GestureKey | null;
  onResume?: () => void; resuming?: boolean;
  onCalibrate: () => void; calibrationSummary: string; calibrated: boolean;
  enabled: boolean; onToggle: (value: boolean) => void; onConfigure: (gesture?: GestureKey) => void; onRun: (gesture: GestureKey) => void; busy?: boolean; status: string; listening: boolean;
  count: number; lastCount: number; lastGesture: string; mode: GestureMode; mappings: GestureMappings; orders: GestureOrders; compact: boolean; dense: boolean;
}) {
  const recordedCount = count || lastCount;
  const activeLabel = activeGesture && defaultGestureOrders.directional.includes(activeGesture) ? gestureNames[activeGesture] : null;
  return <View style={[s.panel, compact && s.compact]} testID="shake-actions">
    <View testID="shake-actions-normal" pointerEvents={activeLabel ? 'none' : 'auto'} accessibilityElementsHidden={!!activeLabel} importantForAccessibility={activeLabel ? 'no-hide-descendants' : 'auto'} style={[s.contents, compact && s.compactContents, activeLabel && s.hiddenContent]}>
    <View style={s.header}><View style={s.heading}><View style={[s.dot, listening && s.liveDot]} /><Text style={s.title}>Shake-to-Action</Text></View>
      <Switch accessibilityLabel="Enable Shake-to-Action" value={enabled} onValueChange={onToggle} trackColor={{ false: t.border, true: t.accentDark }} thumbColor={enabled ? t.accent : t.muted} />
    </View>
    <View style={s.actions}>{gesturesForMode(mode, orders).map(gesture => <Pressable key={gesture} testID={`gesture-card-${gesture}`} accessibilityRole="button" accessibilityLabel={`${enabled ? 'Run' : 'Configure'} ${gestureNames[gesture]}: ${gestureMappingName(mappings[gesture])}`} accessibilityHint={enabled ? 'Runs the saved actions in order' : 'Opens this gesture’s action editor'} accessibilityState={{ disabled: enabled && busy }} disabled={enabled && busy} onPress={() => enabled ? onRun(gesture) : onConfigure(gesture)} style={({ pressed }) => [s.action, mode === 'directional' && s.directionalAction, compact && s.compactAction, lastGesture === gesture && s.highlight, pressed && s.highlight, enabled && busy && s.disabled]}>
      <Text style={s.gesture}>{gestureNames[gesture]}</Text><Text style={s.actionName}>{gestureMappingName(mappings[gesture])}</Text>
    </Pressable>)}</View>
    <Text style={s.tapHint}>{enabled ? 'Tap a card to run its actions.' : 'Tap a card to edit its actions.'}</Text>
    <View style={s.statusRow}><Text style={[s.status, listening && s.liveStatus]}>{status}</Text>
      <Text testID="shake-count" accessibilityLiveRegion="polite" accessibilityLabel={`Recorded shake count: ${recordedCount}`} style={[s.counter, listening && s.liveCounter]}>Shakes: {recordedCount}</Text>
    </View>
    {onResume && <View style={s.calibration}><Text style={s.calibrationSummary}>Completion could not be confirmed. Check your Mac before resuming; the action will not be sent again.</Text><Pressable accessibilityRole="button" accessibilityLabel="Resume gestures" disabled={resuming} onPress={onResume} style={s.calibrateButton}><Text style={s.calibrateText}>{resuming ? 'Resuming…' : 'Resume gestures'}</Text></Pressable></View>}
    <View style={s.bottomRow}><Text style={s.lastGesture}>{lastGesture && Object.hasOwn(gestureNames, lastGesture) ? `Last: ${gestureNames[lastGesture as keyof typeof gestureNames]}` : mode === 'directional' ? 'Use a taught movement · defaults: flick or tilt' : 'Use a taught movement · defaults: shake counts'}</Text><Pressable accessibilityRole="button" accessibilityLabel="Configure gestures" onPressIn={() => console.info('[GestureSettings] configure touch began')} onPress={() => onConfigure()} style={({ pressed }) => [s.configureButton, pressed && s.configurePressed]}><Text style={s.configure}>Configure ↗</Text></Pressable></View>
    <View style={s.calibration}><Text style={s.calibrationSummary}>{calibrationSummary}</Text><Pressable accessibilityRole="button" accessibilityLabel={calibrated ? 'Recalibrate gestures' : 'Calibrate gestures'} onPress={onCalibrate} style={s.calibrateButton}><Text style={s.calibrateText}>{calibrated ? 'Recalibrate gestures' : 'Calibrate gestures'}</Text></Pressable></View>
    {!dense && !compact && <Text style={s.hint}>{mode === 'directional' ? 'A movement resembling any one saved example can run its action. To enable unlocking, save your Mac password in the Mac receiver.' : 'A movement resembling any one saved example can run its action. Killing an app discards unsaved work.'}</Text>}
    </View>
    {activeLabel && <View pointerEvents="none" style={s.executing}><Text testID="gesture-execution-name" accessibilityLiveRegion="polite" style={[s.executionName, compact && s.compactExecutionName]} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.5}>{activeLabel}</Text></View>}
  </View>;
}
const s = StyleSheet.create({
  contents: { gap: 8 }, compactContents: { gap: 6 }, hiddenContent: { opacity: 0 },
  executing: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, alignItems: 'center', justifyContent: 'center', padding: 24 },
  executionName: { color: t.accent, fontSize: 44, fontWeight: '600', textAlign: 'center' }, compactExecutionName: { fontSize: 28 },
  calibration: { gap: 7, paddingTop: 7 }, calibrationSummary: { color: t.muted, fontSize: 11, lineHeight: 16 }, calibrateButton: { minHeight: 48, justifyContent: 'center', alignItems: 'center', backgroundColor: t.accentDark, borderColor: t.accent, borderWidth: 1, borderRadius: 11, paddingHorizontal: 12 }, calibrateText: { color: t.accent, fontSize: 13, fontWeight: '600', textAlign: 'center' },
  panel: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 19, paddingHorizontal: 14, paddingTop: 5, paddingBottom: 12, gap: 8 },
  compact: { width: 230, paddingHorizontal: 12, gap: 6 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }, heading: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: t.dim }, liveDot: { backgroundColor: t.accent }, title: { color: t.text, fontSize: 12, fontWeight: '600' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, action: { flexGrow: 1, flexBasis: '28%', borderRadius: 10, borderWidth: 1, borderColor: t.border, padding: 8, gap: 3, minWidth: 0, minHeight: 48 },
  disabled: { opacity: 0.5 }, tapHint: { color: t.muted, fontSize: 10 },
  directionalAction: { flexBasis: '45%' }, compactAction: { paddingVertical: 6 }, highlight: { borderColor: t.accent, backgroundColor: t.accentDark },
  gesture: { color: t.muted, fontSize: 10 }, actionName: { color: t.text, fontSize: 11, fontWeight: '500' }, statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  status: { flex: 1, color: t.muted, fontSize: 10, lineHeight: 14 }, liveStatus: { color: t.accent }, counter: { color: t.muted, backgroundColor: t.raised, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5, fontSize: 10, fontFamily: t.mono }, liveCounter: { color: t.accent, backgroundColor: t.accentDark },
  bottomRow: { flexDirection: 'row', alignItems: 'center', gap: 8 }, lastGesture: { color: t.muted, fontSize: 9, flex: 1 }, configureButton: { minHeight: 48, minWidth: 108, paddingHorizontal: 14, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: t.accent, borderRadius: 11, backgroundColor: t.raised }, configurePressed: { backgroundColor: t.accentDark }, configure: { color: t.accent, fontSize: 13, fontWeight: '600' }, hint: { color: t.dim, fontSize: 9, lineHeight: 13 },
});
