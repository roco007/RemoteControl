import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { gestureBridge } from '../modules/gesture-service';
import { gestureMappingName, gestureNames, gestureSteps, gesturesForMode, reorderGesture, type GestureActionStep, type GestureKey } from '../services/gestureSettings';
import type { Settings } from '../services/settings';
import { theme as t } from './theme';
import { ReorderableGestureList } from './ReorderableGestureList';
import { CALIBRATION_TAKES } from '../services/gestureCalibrationDefaults';
import { GestureActionList } from './GestureActionList';
import type { InstalledApplication } from '../services/applicationCatalog';

export function GestureSettings({ visible, initialGesture = null, onClose, settings, onSettings, onCalibrate, calibrated, calibrationSummary, loadServerApps, serverCatalogKey }: { visible: boolean; initialGesture?: GestureKey | null; onClose: () => void; settings: Settings; onSettings: (next: Settings) => void; onCalibrate: () => void; calibrated: boolean; calibrationSummary: string; loadServerApps: () => Promise<InstalledApplication[]>; serverCatalogKey?: string }) {
  const [editing, setEditing] = useState<GestureKey | null>(null);
  const [notice, setNotice] = useState('');
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const content = useRef<React.ComponentRef<typeof View>>(null);
  const mappings = useRef(new Map<GestureKey, React.ComponentRef<typeof View>>());
  const shown = useRef(false);
  const viewportHeight = useRef(0);
  const contentHeight = useRef(0);
  const pendingScroll = useRef<{ gesture: GestureKey | null; editorReady: boolean } | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const cancelInitialScroll = useCallback(() => {
    pendingScroll.current = null;
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
  }, []);
  const queueInitialScroll = useCallback(() => {
    const request = pendingScroll.current;
    if (!request || !shown.current || viewportHeight.current <= 0 || contentHeight.current <= 0 || scrollFrame.current !== null) return;
    if (request.gesture && !request.editorReady) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      if (pendingScroll.current !== request || !scroll.current) return;
      if (!request.gesture) {
        pendingScroll.current = null;
        scroll.current.scrollTo({ y: 0, animated: false });
        return;
      }
      const mapping = mappings.current.get(request.gesture);
      if (!mapping || !content.current) return;
      // Measure the expanded row in the scroll content's coordinate space.
      // Saved card order, wrapped text, and different action counts all affect y.
      mapping.measureLayout(content.current, (_x, y, _width, height) => {
        if (pendingScroll.current !== request || height <= 0 || contentHeight.current + 1 < y + height) return;
        pendingScroll.current = null;
        scroll.current?.scrollTo({ y: Math.max(0, y - 12), animated: false });
      }, () => {});
    });
  }, []);
  useLayoutEffect(() => {
    console.info('[GestureSettings] visibility changed', visible);
    cancelInitialScroll();
    if (!visible) { shown.current = false; setEditing(null); return; }
    const target = initialGesture && gesturesForMode(settings.gestureMode).includes(initialGesture) ? initialGesture : null;
    setEditing(target);
    pendingScroll.current = { gesture: target, editorReady: false };
    queueInitialScroll();
    // Each opening owns one scroll request; editing, reordering, and settings
    // updates must not reopen the initial gesture or take over the user's scroll.
  }, [visible, initialGesture, cancelInitialScroll, queueInitialScroll]);
  useEffect(() => cancelInitialScroll, [cancelInitialScroll]);
  const close = () => { console.info('[GestureSettings] close requested'); cancelInitialScroll(); Keyboard.dismiss(); setEditing(null); onClose(); };
  const [dragging, setDragging] = useState(false);
  const [pinning, setPinning] = useState(false);
  const backgroundAvailable = Platform.OS === 'android' && !!gestureBridge;
  const setAction = (gesture: GestureKey, action: GestureActionStep[]) => onSettings({ ...settings, gestureMappings: { ...settings.gestureMappings, [gesture]: action } });
  const gestures = gesturesForMode(settings.gestureMode, settings.gestureOrders);
  const defaultOrder = gesturesForMode(settings.gestureMode);
  const orderChanged = gestures.some((gesture, index) => gesture !== defaultOrder[index]);
  const move = (gesture: GestureKey, targetIndex: number) => onSettings({ ...settings, gestureOrders: reorderGesture(settings.gestureOrders, settings.gestureMode, gesture, targetIndex) });
  const addWidget = async () => {
    if (!gestureBridge || pinning) return;
    setPinning(true);
    try {
      const requested = await gestureBridge.requestPinWidget();
      setNotice(requested ? 'Confirm Add on your home screen. The widget switches gesture controls on and off.' : 'Touch and hold an empty area of your home screen, choose Widgets, then add Remote Mac Gesture controls.');
    } catch {
      setNotice('Touch and hold an empty area of your home screen, choose Widgets, then add Remote Mac Gesture controls.');
    } finally { setPinning(false); }
  };
  return <Modal visible={visible} onShow={() => { if (!visible) return; console.info('[GestureSettings] sheet shown'); shown.current = true; queueInitialScroll(); }} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}><SafeAreaView style={s.safe}><KeyboardAvoidingView style={s.sheet} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={s.header}><View><Text style={s.eyebrow}>YOUR MOTION, YOUR SHORTCUTS</Text><Text style={s.title}>Gesture controls</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Close gesture settings" onPress={close} style={s.close}><Text style={s.closeText}>×</Text></Pressable></View>
    <ScrollView ref={scroll} testID="gesture-settings-scroll" scrollEnabled={!dragging} keyboardShouldPersistTaps="handled" onLayout={event => { viewportHeight.current = event.nativeEvent.layout.height; queueInitialScroll(); }} onContentSizeChange={(_width, height) => { contentHeight.current = height; queueInitialScroll(); }} onScrollBeginDrag={cancelInitialScroll} onTouchStart={cancelInitialScroll}>
      <View ref={content} collapsable={false} style={s.content} onLayout={event => { contentHeight.current = event.nativeEvent.layout.height; queueInitialScroll(); }}>
      <View><Pressable accessibilityRole="button" accessibilityLabel={calibrated ? 'Recalibrate gestures' : 'Calibrate gestures'} onPress={onCalibrate} style={s.widgetButton}><Text style={s.widgetButtonText}>{calibrated ? 'Recalibrate gestures' : 'Calibrate gestures'}</Text></Pressable><Text style={s.description}>{calibrationSummary}. Teach one label or all seven with {CALIBRATION_TAKES} takes each. Hold the phone upright: X (left/right) and Y (up/down) are used; depth Z is ignored. Choose a different comfortable movement for each shortcut. Every take is kept; any one saved example can trigger its action. Recording works with gestures off and without a Mac connection.</Text></View>
      <View style={s.row}><View style={s.rowText}><Text style={s.label}>Enable gestures</Text><Text style={s.description}>The master switch for all motion shortcuts</Text></View><Switch accessibilityLabel="Enable gestures" value={settings.shakeActions} onValueChange={v => onSettings({ ...settings, shakeActions: v })} trackColor={{ true: t.accentDark, false: t.border }} thumbColor={settings.shakeActions ? t.accent : t.muted} /></View>
      <View style={s.row}><View style={s.rowText}><Text style={s.label}>Keep active in background</Text><Text style={s.description}>Listen when you leave or swipe away this app. Phone actions work offline; Mac actions use Wi-Fi. Uses a persistent notification.</Text></View><Switch accessibilityLabel="Keep active in background" disabled={!backgroundAvailable} value={backgroundAvailable && settings.backgroundGestures} onValueChange={v => { onSettings({ ...settings, backgroundGestures: v }); if (v) void gestureBridge?.requestNotificationPermission().then(granted => { if (!granted) setNotice('Allow notifications in Android settings to see the listening status and Stop button.'); }).catch(() => setNotice('Check notification permission in Android settings.')); }} trackColor={{ true: t.accentDark, false: t.border }} thumbColor={settings.backgroundGestures && backgroundAvailable ? t.accent : t.muted} /></View>
      <Text style={s.note}>{backgroundAvailable ? 'Force Stop or restarting the phone ends listening; open Remote Mac again to resume. Background Mac actions need your saved Mac Wi-Fi address.' : 'Background and directional gestures require the updated Android app. On iPhone, shake counts work while the app is open.'}</Text>
      {backgroundAvailable && <View><Pressable accessibilityRole="button" accessibilityLabel="Add home-screen widget" accessibilityState={{ disabled: pinning }} disabled={pinning} onPress={() => { void addWidget(); }} style={[s.widgetButton, pinning && s.disabled]}><Text style={s.widgetButtonText}>{pinning ? 'Opening home screen…' : 'Add home-screen widget'}</Text></Pressable><Text style={s.description}>Switch gestures on or off from your home screen. Turning them on with the widget also enables background listening.</Text></View>}
      {!!notice && <Text accessibilityLiveRegion="polite" style={s.notice}>{notice}</Text>}
      <View style={s.modeRow}>{(['directional', 'count'] as const).map(mode => <Pressable key={mode} accessibilityRole="tab" accessibilityState={{ selected: settings.gestureMode === mode, disabled: mode === 'directional' && Platform.OS === 'ios' }} disabled={mode === 'directional' && Platform.OS === 'ios'} onPress={() => { cancelInitialScroll(); onSettings({ ...settings, gestureMode: mode }); setEditing(null); }} style={[s.mode, settings.gestureMode === mode && s.selected]}><Text style={[s.modeText, settings.gestureMode === mode && s.selectedText]}>{mode === 'count' ? 'Shake count' : 'Directional'}</Text></Pressable>)}</View>
      <Text style={s.description}>{settings.gestureMode === 'directional' ? 'Default examples: a sideways flick for Left or Right, or a tilt and return for Straight. After teaching a label, use the movements you recorded for it.' : 'Default examples: one, two or three shakes. After teaching a label, use the movements you recorded for it.'} Distinct movements for different labels help avoid confusion.</Text>
      <View>
        <View style={s.row}><Text style={[s.label, s.rowText]}>Card order</Text><Pressable accessibilityRole="button" accessibilityLabel="Reset gesture card order" accessibilityState={{ disabled: !orderChanged }} disabled={!orderChanged} onPress={() => onSettings({ ...settings, gestureOrders: { ...settings.gestureOrders, [settings.gestureMode]: defaultOrder } })} style={[s.reset, !orderChanged && s.disabled]}><Text style={s.resetText}>Reset order</Text></Pressable></View>
        <Text style={s.description}>Drag a grip to arrange cards from left to right, then top to bottom. Each mode remembers its own order.</Text>
      </View>
      <ReorderableGestureList key={settings.gestureMode} gestures={gestures} enabled={visible} onMove={move} onDraggingChange={value => { if (value) cancelInitialScroll(); setDragging(value); }} renderItem={(gesture, index, handle) => <View ref={node => { if (node) mappings.current.set(gesture, node); else mappings.current.delete(gesture); }} collapsable={false} testID={`gesture-mapping-${gesture}`} onLayout={queueInitialScroll} style={s.mapping}>
        <View style={s.mappingRow}>
          <Text style={s.position}>{index + 1}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Change action for ${gestureNames[gesture]}`} accessibilityState={{ expanded: editing === gesture }} onPress={() => { cancelInitialScroll(); setEditing(editing === gesture ? null : gesture); }} style={s.rowText}><Text style={s.label}>{gestureNames[gesture]}</Text><Text style={s.action}>{gestureMappingName(settings.gestureMappings[gesture])} ⌄</Text></Pressable>
          {handle}
        </View>
        {editing === gesture && <View testID={`gesture-editor-${gesture}`} onLayout={() => { if (pendingScroll.current?.gesture === gesture) pendingScroll.current.editorReady = true; queueInitialScroll(); }}><GestureActionList steps={gestureSteps(gesture, settings.gestureMappings)} onChange={steps => setAction(gesture, steps)} loadServerApps={loadServerApps} serverCatalogKey={serverCatalogKey} /></View>}
      </View>} />
      <Text style={s.note}>Lock/Unlock Mac follows your Mac's current lock state. Save your Mac password in the Mac receiver to enable unlocking. Kill current app can discard unsaved work.</Text>
      </View>
    </ScrollView>
  </KeyboardAvoidingView></SafeAreaView></Modal>;
}
const s = StyleSheet.create({
  widgetButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: t.accentDark, borderWidth: 1, borderColor: t.accent }, widgetButtonText: { color: t.accent, fontSize: 13, fontWeight: '600' },
  mappingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 }, position: { width: 16, color: t.dim, fontFamily: t.mono, fontSize: 11 }, disabled: { opacity: 0.3 }, reset: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }, resetText: { color: t.accent, fontSize: 12 },
  safe: { flex: 1, backgroundColor: t.bg }, sheet: { flex: 1, width: '100%', maxWidth: 640, alignSelf: 'center' }, header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 22 }, eyebrow: { color: t.dim, fontSize: 8, letterSpacing: 1.3, marginBottom: 9 }, title: { color: t.text, fontSize: 22, fontWeight: '600' }, close: { width: 38, height: 38, borderRadius: 19, backgroundColor: t.raised, alignItems: 'center', justifyContent: 'center' }, closeText: { color: t.text, fontSize: 25 }, content: { padding: 22, paddingTop: 4, gap: 18, paddingBottom: 40 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 }, rowText: { flex: 1 }, label: { color: t.text, fontSize: 14, fontWeight: '500' }, description: { color: t.muted, fontSize: 12, lineHeight: 18, marginTop: 5 }, note: { color: t.dim, fontSize: 11, lineHeight: 17 }, notice: { color: t.warning, fontSize: 12 }, modeRow: { flexDirection: 'row', gap: 8 }, mode: { flex: 1, alignItems: 'center', padding: 13, borderRadius: 12, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border }, modeText: { color: t.muted, fontSize: 12 }, selected: { backgroundColor: t.accentDark, borderColor: t.accent }, selectedText: { color: t.accent }, mapping: { padding: 14, borderWidth: 1, borderColor: t.border, borderRadius: 14, backgroundColor: t.surface, gap: 12 }, action: { color: t.accent, fontSize: 12, marginTop: 6 }, choices: { gap: 6 }, choice: { borderWidth: 1, borderColor: t.border, padding: 12, borderRadius: 9 }, choiceText: { color: t.text, fontSize: 12 },
});
