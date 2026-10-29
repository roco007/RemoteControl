import React, { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useKeepAwake } from 'expo-keep-awake';
import type { GestureCalibrationStatus, GestureId } from '../modules/gesture-service';
import type { CalibrationBusy } from '../services/GestureCalibrationController';
import { CALIBRATION_TAKES } from '../services/gestureCalibrationDefaults';
import { draftReadingsGestures } from '../services/calibrationReadings';
import { CalibrationReadingsInspector } from './CalibrationReadingsInspector';
import { theme as t } from './theme';

const prompts: Record<GestureId, { name: string; mark: string; instruction: string }> = {
  left: { name: 'Flick left', mark: '←', instruction: 'Optional example: a gentle flick to the left. You can teach this label your own movement.' },
  right: { name: 'Flick right', mark: '→', instruction: 'Optional example: a gentle flick to the right. You can teach this label your own movement.' },
  left_straight: { name: 'Left → Straight', mark: '↶ │', instruction: 'Optional example: tilt the top of the upright phone left, then bring it back. You can teach this label your own X/Y movement.' },
  right_straight: { name: 'Right → Straight', mark: '↷ │', instruction: 'Optional example: tilt the top of the upright phone right, then bring it back. You can teach this label your own X/Y movement.' },
  single: { name: 'Shake once', mark: '1', instruction: 'Optional example: one shake. You can teach this label your own movement.' },
  double: { name: 'Shake twice', mark: '2', instruction: 'Optional example: two shakes. You can teach this label your own movement.' },
  triple: { name: 'Shake three times', mark: '3', instruction: 'Optional example: three shakes. You can teach this label your own movement.' },
};
const order: GestureId[] = ['left', 'right', 'left_straight', 'right_straight', 'single', 'double', 'triple'];
function StayAwake() { useKeepAwake(); return null; }
function TiltReturnGuide({ side }: { side: 'left' | 'right' }) {
  return <View accessible accessibilityRole="image" accessibilityLabel={`Optional example: tilt the top of the phone to the ${side}, then bring it upright. Your own movement is welcome.`} style={s.tiltGuide}>
    <View style={s.phoneStep}><View style={[s.phoneOutline, { transform: [{ rotate: side === 'left' ? '-25deg' : '25deg' }] }]}><View style={s.phoneSpeaker} /><View style={s.phoneHome} /></View><Text style={s.phoneCaption}>Tilt {side}</Text></View>
    <Text style={s.returnArrow}>→</Text>
    <View style={s.phoneStep}><View style={s.phoneOutline}><View style={s.phoneSpeaker} /><View style={s.phoneHome} /></View><Text style={s.phoneCaption}>Upright</Text></View>
  </View>;
}


export function GestureCalibration({ visible, available, status, busy, error, onStart, onResume, onCapture, onSave, onCancel, onRefresh }: {
  visible: boolean; available: boolean; status: GestureCalibrationStatus | null; busy: CalibrationBusy; error: string;
  onStart: (gesture?: GestureId) => void; onResume: () => void; onCapture: () => void; onSave: () => void; onCancel: () => void; onRefresh: () => void;
}) {
  const active = status?.active === true;
  const phase = status?.phase;
  const recording = phase === 'hold_still' || phase === 'recording';
  const review = active && phase === 'review';
  const interrupted = active && phase === 'interrupted';
  const failed = active && phase === 'error';
  const selected = status?.gestures?.length ? status.gestures : order;
  const calibratedGestures = status?.calibratedGestures ?? [];
  const learnedGestures = status?.learnedGestures ?? [];
  const repetitions = status?.repetitions ?? CALIBRATION_TAKES;
  const take = Math.min(status?.repetition ?? 1, repetitions);
  const totalSteps = status?.totalSteps ?? selected.length;
  const prompt = status?.gesture ? prompts[status.gesture] : null;
  const tiltSide = status?.gesture === 'left_straight' ? 'left' : status?.gesture === 'right_straight' ? 'right' : null;
  const cancelDisabled = busy === 'starting' || busy === 'saving' || busy === 'canceling';
  const noSensor = status?.sensorAvailable === false;
  const savedDate = status?.calibratedAt ? new Date(status.calibratedAt).toLocaleString() : null;
  const accepted = status?.accepted ?? 0;
  const total = status?.total ?? selected.length * repetitions;
  const canRecord = active && phase === 'ready' && !busy && !noSensor;
  const [readings, setReadings] = useState<{ gestures: GestureId[]; sessionId: string | null; contextSessionId: string; profileRevision: number } | null>(null);
  const canViewReadings = available && visible && !busy && !recording;
  const inspector = readings && canViewReadings && readings.contextSessionId === status?.sessionId && readings.profileRevision === status?.profileRevision &&
    (readings.sessionId === null || (active && readings.sessionId === status?.sessionId)) ? readings : null;
  const draftGestures = active && status ? draftReadingsGestures(status) : [];
  const openReadings = (gestures: GestureId[], sessionId: string | null) => {
    if (!canViewReadings || !status || !gestures.length) return;
    setReadings({ gestures, sessionId, contextSessionId: status.sessionId, profileRevision: status.profileRevision });
  };
  const closeReadings = () => setReadings(null);
  useEffect(() => { if (readings && !inspector) setReadings(null); }, [readings, inspector]);
  const content = useRef<React.ComponentRef<typeof ScrollView>>(null);
  useEffect(() => {
    if (visible) content.current?.scrollTo({ y: 0, animated: false });
  }, [visible, active, recording, interrupted, failed, review, status?.step, status?.sessionId, !!inspector]);
  const button = (label: string, action: () => void, disabled = false, secondary = false) => <Pressable
    accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={action}
    style={[s.button, secondary && s.secondary, disabled && s.disabled]}>
    <Text style={[s.buttonText, secondary && s.secondaryText]}>{label}</Text>
  </Pressable>;

  return <Modal visible={visible} animationType="slide" onRequestClose={() => { if (inspector) closeReadings(); else if (!cancelDisabled) onCancel(); }}>
    {visible && Platform.OS !== 'web' && <StayAwake />}
    <SafeAreaView style={s.safe}>
      <View style={s.sheet}>
        <View style={s.header}>
          <View style={s.heading}><Text style={s.eyebrow}>MADE FOR YOUR MOVEMENT</Text><Text style={s.title}>{inspector ? 'Take readings' : 'Gesture calibration'}</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel={inspector ? 'Close readings' : 'Cancel and close calibration'} accessibilityState={{ disabled: cancelDisabled }} disabled={cancelDisabled} onPress={inspector ? closeReadings : onCancel} style={[s.close, cancelDisabled && s.disabled]}><Text style={s.closeText}>×</Text></Pressable>
        </View>
        <ScrollView ref={content} contentContainerStyle={s.content}>
          {inspector ? <CalibrationReadingsInspector key={`${inspector.sessionId ?? 'saved'}/${inspector.profileRevision}`} gestures={inspector.gestures} sessionId={inspector.sessionId} profileRevision={inspector.profileRevision} onBack={closeReadings} /> : <>
          {available && learnedGestures.length > 0 && button('View saved readings', () => openReadings(learnedGestures, null), !canViewReadings, true)}
          {!available ? <View style={s.card}>
            <Text style={s.sectionTitle}>Use the Android phone app</Text>
            <Text style={s.body}>Motion calibration needs the updated Android app and its motion sensor.</Text>
          </View> : !active ? <>
            <Text style={s.introTitle}>Teach your phone how you move.</Text>
            <Text style={s.body}>Choose one gesture label or all seven. Pick a different comfortable movement for each shortcut, then repeat that same movement {CALIBRATION_TAKES} times. Every recorded take is kept.</Text>
            <Text style={s.body}>Hold the phone upright, with its screen facing you. Recognition uses X (left/right) and Y (up/down). Z motion toward or away from you is ignored.</Text>
            <Text style={s.body}>A movement resembling any one saved example can run that label’s action.</Text>
            <View style={s.card}>
              <Text style={s.sectionTitle}>Easy movements to try</Text>
              <Text style={s.body}>• Gently tilt left, then bring the phone upright.{ '\n' }• Gently tilt right, then bring it upright.{ '\n' }• Move the upright phone a little upward, then back.{ '\n' }• Move it a little downward, then back.</Text>
              <Text style={s.note}>These are optional ideas. Choose what feels comfortable and make each shortcut’s movement distinct. No exact angle or direction is required.</Text>
            </View>
            {button(busy === 'starting' ? 'Starting…' : 'Calibrate all', () => onStart(), !!busy || noSensor)}
            <Text style={s.sectionTitle}>Or choose one gesture label</Text>
            <View style={s.movementList}>{order.map(id => {
              const movementStatus = learnedGestures.includes(id) ? 'Learned · Record again' : calibratedGestures.includes(id) ? `Earlier calibration · Learn from ${CALIBRATION_TAKES} takes` : `Not learned yet · Record ${CALIBRATION_TAKES} takes`;
              return <Pressable key={id} accessibilityRole="button" accessibilityLabel={`${calibratedGestures.includes(id) ? 'Recalibrate' : 'Calibrate'} ${prompts[id].name.toLowerCase()}`} accessibilityHint={movementStatus} accessibilityState={{ disabled: !!busy || noSensor }} disabled={!!busy || noSensor} onPress={() => onStart(id)} style={[s.movementButton, (!!busy || noSensor) && s.disabled]}><Text style={s.movementMark}>{prompts[id].mark}</Text><View style={s.movementText}><Text style={s.movementName}>{prompts[id].name}</Text><Text style={s.movementStatus}>{movementStatus}</Text></View><Text style={s.movementArrow}>↗</Text></Pressable>;
            })}</View>
            <View style={s.card}>
              <Text style={s.sectionTitle}>Take it at your pace</Text>
              <Text style={s.body}>Tap Record for each take. After the brief preparation, make your movement naturally and wait for the recording to finish.</Text>
              <Text style={s.body}>The next take waits for you. Save after all {CALIBRATION_TAKES} takes per selected label. You can teach any label again later.</Text>
            </View>
            <Text style={s.note}>You can calibrate with gestures off and without connecting to your Mac. Gesture actions pause while you practice.</Text>
            <Text style={s.note}>{savedDate ? `Last saved: ${savedDate}. Your earlier calibration stays saved until you save these new takes.` : 'Not learned yet. Your gesture mappings stay the same.'}</Text>
          </> : <>
            <View style={s.progressHeading}><Text style={s.eyebrow}>{review ? 'READY TO SAVE' : `MOVEMENT ${Math.min((status?.step ?? 0) + 1, totalSteps)} OF ${totalSteps}`}</Text><Text style={s.progressCount}>{accepted} / {total} takes</Text></View>
            <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: total, now: accepted }} accessibilityLabel="Recorded calibration takes" style={s.progressTrack}><View style={[s.progressFill, { width: `${Math.min(100, accepted / Math.max(1, total) * 100)}%` }]} /></View>
            {review ? <>
              <Text style={s.introTitle}>Ready to save.</Text>
              <Text style={s.body}>Save all {repetitions} examples for each label. A movement resembling any one saved example can run its action in the app or background. Other saved labels stay as they are.</Text>
              <View style={s.card}>{selected.map((id, index) => <View key={id} style={s.reviewRow}><Text style={s.reviewName}>{prompts[id].name}</Text><Text style={s.accepted}>✓ {Math.min(repetitions, Math.max(0, accepted - index * repetitions))} of {repetitions} takes</Text></View>)}</View>
            </> : interrupted || failed ? <View style={s.card}>
              <Text style={s.sectionTitle}>{interrupted ? 'Calibration paused' : 'Recording unavailable'}</Text>
              <Text style={s.body}>{status?.message || 'Continue when you’re ready.'}</Text>
              {interrupted && <Text style={s.body}>{accepted} of {total} takes recorded. Continue from where you stopped; your recorded takes are kept.</Text>}
              <Text style={s.note}>Gesture actions remain paused. Your previous calibration is unchanged.</Text>
            </View> : <>
              <View style={[s.practice, phase === 'recording' && s.practiceLive]}>
                <Text style={s.repetition}>Take {take} of {repetitions}</Text>
                {tiltSide && phase !== 'hold_still' ? <TiltReturnGuide side={tiltSide} /> : <Text style={s.mark}>{phase === 'hold_still' ? '·' : prompt?.mark}</Text>}
                <Text accessibilityLiveRegion="polite" style={s.phaseTitle}>{phase === 'hold_still' ? 'Get ready' : phase === 'recording' ? 'Record your movement' : prompt?.name}</Text>
                {phase === 'hold_still' && <Text style={s.timer}>{Math.ceil((status?.remainingMs ?? 0) / 1000)}s</Text>}
                <Text style={s.practiceText}>{phase === 'hold_still' ? 'Brief preparation. Recording starts when the card turns green.' : prompt?.instruction}</Text>
              </View>
              <Text accessibilityLiveRegion="polite" style={s.feedback}>{status?.message}</Text>
              <Text style={s.note}>Keep the phone upright. X/Y movement is learned; depth Z is ignored. Every take is kept, with no required angle, shake count or return position.</Text>
              {!recording && <>
                <Text style={s.note}>Repeat the same comfortable movement for all {repetitions} takes of this shortcut. Tap Record when you’re ready.</Text>
                <Text style={s.note}>Optional easy ideas: tilt left or right and return upright, or move the upright phone a little up or down and back. Choose a different movement for each shortcut.</Text>
              </>}
            </>}
            {review && <Text style={s.note}>Your mappings and on/off setting stay the same. You can recalibrate again at any time.</Text>}
          </>}
          {noSensor && available && <Text style={s.error}>A motion sensor isn’t available on this device.</Text>}
          {!!error && <View accessibilityLiveRegion="polite" style={s.errorBox}><Text style={s.error}>{error}</Text>{!active && button('Check again', onRefresh, !!busy, true)}</View>}
          <View style={s.controls}>
            {available && draftGestures.length > 0 && button('View recorded takes', () => openReadings(draftGestures, status!.sessionId), !canViewReadings, true)}
            {available && active && !review && !interrupted && !failed && button(recording ? 'Recording…' : `Record take ${take} of ${repetitions}`, onCapture, !canRecord)}
            {available && interrupted && button(busy === 'resuming' ? 'Continuing…' : 'Continue calibration', onResume, !!busy || noSensor)}
            {available && failed && button('Restart this calibration', () => onStart(selected.length === 1 ? selected[0] : undefined), !!busy || noSensor)}
            {available && review && button(busy === 'saving' ? 'Saving…' : 'Save calibration', onSave, !!busy || !status?.canSave)}
            {button(busy === 'canceling' ? 'Canceling…' : active ? 'Cancel calibration' : 'Close calibration', onCancel, cancelDisabled, true)}
          </View>
          </>}
        </ScrollView>
      </View>
    </SafeAreaView>
  </Modal>;
}

const s = StyleSheet.create({
  tiltGuide: { minHeight: 124, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14 }, phoneStep: { width: 74, alignItems: 'center', gap: 18, paddingTop: 8 }, phoneOutline: { width: 40, height: 72, borderRadius: 8, borderWidth: 2, borderColor: t.accent, backgroundColor: t.raised, alignItems: 'center', justifyContent: 'space-between', paddingVertical: 5 }, phoneSpeaker: { width: 13, height: 3, borderRadius: 2, backgroundColor: t.accent }, phoneHome: { width: 12, height: 2, borderRadius: 1, backgroundColor: t.muted }, phoneCaption: { color: t.muted, fontSize: 11 }, returnArrow: { color: t.accent, fontSize: 25, marginBottom: 26 },
  safe: { flex: 1, backgroundColor: t.bg }, sheet: { flex: 1, width: '100%', maxWidth: 640, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 22, paddingBottom: 16 }, heading: { flex: 1, gap: 8 }, eyebrow: { color: t.dim, fontSize: 9, letterSpacing: 1.2 }, title: { color: t.text, fontSize: 23, fontWeight: '600' },
  close: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: t.raised }, closeText: { color: t.text, fontSize: 28 },
  content: { padding: 22, paddingTop: 8, paddingBottom: 36, gap: 18 }, introTitle: { color: t.text, fontSize: 25, fontWeight: '600', lineHeight: 32 }, body: { color: t.muted, fontSize: 14, lineHeight: 21 }, note: { color: t.dim, fontSize: 12, lineHeight: 18 },
  card: { backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, borderRadius: 18, padding: 18, gap: 12 }, sectionTitle: { color: t.text, fontSize: 16, fontWeight: '600' },
  movementList: { gap: 8 }, movementButton: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 13, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface }, movementMark: { width: 58, textAlign: 'center', color: t.accent, fontSize: 24 }, movementText: { flex: 1, gap: 4 }, movementName: { color: t.text, fontSize: 14, fontWeight: '500' }, movementStatus: { color: t.muted, fontSize: 11 }, movementArrow: { color: t.accent, fontSize: 19 },
  progressHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }, progressCount: { color: t.muted, fontSize: 12 }, progressTrack: { height: 5, borderRadius: 3, overflow: 'hidden', backgroundColor: t.raised }, progressFill: { height: 5, borderRadius: 3, backgroundColor: t.accent },
  practice: { borderRadius: 22, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface, padding: 22, alignItems: 'center', gap: 12 }, practiceLive: { borderColor: t.accent, backgroundColor: t.accentDark }, repetition: { color: t.muted, fontSize: 10, letterSpacing: 1 }, mark: { color: t.accent, fontSize: 70, lineHeight: 82 }, phaseTitle: { color: t.text, fontSize: 25, fontWeight: '600', textAlign: 'center' }, timer: { color: t.accent, fontSize: 20, fontFamily: t.mono }, practiceText: { color: t.muted, fontSize: 14, lineHeight: 22, textAlign: 'center' }, feedback: { color: t.accent, fontSize: 13, lineHeight: 20 },
  reviewRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }, reviewName: { color: t.text, fontSize: 14 }, accepted: { color: t.accent, fontSize: 12 },
  controls: { gap: 10, marginTop: 4 }, button: { minHeight: 50, justifyContent: 'center', alignItems: 'center', padding: 14, borderRadius: 13, borderWidth: 1, borderColor: t.accent, backgroundColor: t.accent }, buttonText: { color: t.bg, fontSize: 14, fontWeight: '600', textAlign: 'center' }, secondary: { backgroundColor: t.surface, borderColor: t.border }, secondaryText: { color: t.muted }, disabled: { opacity: 0.45 }, errorBox: { gap: 12 }, error: { color: t.error, fontSize: 13, lineHeight: 20 },
});
