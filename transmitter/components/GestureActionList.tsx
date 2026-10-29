import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { gestureBridge } from '../modules/gesture-service';
import { actionNames, actionStepName, MAX_GESTURE_ACTIONS, sanitizeGestureStep, type BuiltinGestureAction, type GestureActionStep } from '../services/gestureSettings';
import { sanitizeApplications, type InstalledApplication } from '../services/applicationCatalog';
import { GestureApplicationPicker } from './GestureApplicationPicker';
import { theme as t } from './theme';
import { MAX_OPEN_URL_LENGTH } from '../../shared/openUrl';

type Props = { steps: GestureActionStep[]; onChange: (steps: GestureActionStep[]) => void; loadServerApps: () => Promise<InstalledApplication[]>; serverCatalogKey?: string };
const builtins: BuiltinGestureAction[] = ['screenshot', 'kill_app', 'lock', 'photo_booth'];
type EditorKind = 'system' | 'mobile' | 'server' | 'command' | 'server_url' | 'mobile_url';
const kinds: { id: EditorKind; label: string }[] = [{ id: 'system', label: 'Mac action' }, { id: 'mobile', label: 'Phone app' }, { id: 'server', label: 'Mac app' }, { id: 'command', label: 'Mac command' }, { id: 'server_url', label: 'Open URL on Mac' }, { id: 'mobile_url', label: 'Open URL on Phone' }];
const unavailableKind = (kind: EditorKind) => (kind === 'mobile' && Platform.OS !== 'android') || (kind === 'mobile_url' && Platform.OS === 'web');

export function GestureActionList({ steps, onChange, loadServerApps, serverCatalogKey }: Props) {
  const [editing, setEditing] = useState<number | null>(null);
  const move = (index: number, direction: -1 | 1) => {
    const next = steps.map(step => ({ ...step }));
    const destination = index + direction;
    if (destination < 0 || destination >= next.length) return;
    next.splice(destination, 0, next.splice(index, 1)[0]!);
    onChange(next); setEditing(null);
  };
  return <View style={s.list}>
    <Text style={s.description}>Actions run in this order. A failed action lets the next one run; an unconfirmed result pauses the list.</Text>
    {!steps.length && <Text style={s.description}>This gesture is disabled. Add an action to enable it.</Text>}
    {steps.map((step, index) => <View key={index} style={s.step}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Edit action ${index + 1}: ${actionStepName(step)}`} onPress={() => setEditing(index)} style={s.stepLabel}>
        <Text style={s.stepName}>{index + 1}. {actionStepName(step)}</Text>
        {step.type === 'run_command' && <Text style={s.commandPreview} numberOfLines={1}>{step.command}</Text>}
        {step.type === 'open_url' && <Text style={s.commandPreview} numberOfLines={2}>{step.url}</Text>}
        <Text style={s.editHint}>Edit</Text>
      </Pressable>
      <View style={s.tools}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Move action ${index + 1} earlier`} disabled={index === 0} onPress={() => move(index, -1)} style={[s.tool, index === 0 && s.disabled]}><Text style={s.toolText}>↑</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Move action ${index + 1} later`} disabled={index === steps.length - 1} onPress={() => move(index, 1)} style={[s.tool, index === steps.length - 1 && s.disabled]}><Text style={s.toolText}>↓</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Remove action ${index + 1}`} onPress={() => { onChange(steps.filter((_, i) => i !== index)); setEditing(null); }} style={s.tool}><Text style={s.removeText}>×</Text></Pressable>
      </View>
    </View>)}
    {editing === null ? <Pressable accessibilityRole="button" accessibilityLabel="Add gesture action" disabled={steps.length >= MAX_GESTURE_ACTIONS} onPress={() => setEditing(steps.length)} style={[s.add, steps.length >= MAX_GESTURE_ACTIONS && s.disabled]}><Text style={s.addText}>{steps.length >= MAX_GESTURE_ACTIONS ? `Maximum ${MAX_GESTURE_ACTIONS} actions` : '+ Add action'}</Text></Pressable> : <StepEditor key={editing} initial={steps[editing]} loadServerApps={loadServerApps} serverCatalogKey={serverCatalogKey} onCancel={() => setEditing(null)} onSave={step => {
      const next = [...steps]; next[editing] = step; onChange(next); setEditing(null);
    }} />}
  </View>;
}

async function loadPhoneApps(): Promise<InstalledApplication[]> {
  if (Platform.OS !== 'android' || !gestureBridge?.listInstalledApps) throw new Error('Phone app discovery requires the updated Android app.');
  return sanitizeApplications(await gestureBridge.listInstalledApps());
}

function StepEditor({ initial, onSave, onCancel, loadServerApps, serverCatalogKey }: {
  initial?: GestureActionStep; onSave: (step: GestureActionStep) => void; onCancel: () => void; loadServerApps: Props['loadServerApps']; serverCatalogKey?: string;
}) {
  const initialKind: EditorKind = initial?.type === 'open_app' ? initial.target : initial?.type === 'run_command' ? 'command' : initial?.type === 'open_url' ? initial.target === 'mobile' ? 'mobile_url' : 'server_url' : 'system';
  const [kind, setKind] = useState<EditorKind>(initialKind);
  const [action, setAction] = useState<BuiltinGestureAction>(initial?.type === 'system' ? initial.action : 'screenshot');
  const [selected, setSelected] = useState<InstalledApplication | null>(initial?.type === 'open_app' ? { id: initial.appId, name: initial.appName || initial.appId } : null);
  const [command, setCommand] = useState(initial?.type === 'run_command' ? initial.command : '');
  const [url, setUrl] = useState(initial?.type === 'open_url' ? initial.url : '');
  const editingUrl = kind === 'server_url' || kind === 'mobile_url';
  const candidate = kind === 'system' ? { type: 'system', action } : kind === 'command' ? { type: 'run_command', command } : editingUrl ? { type: 'open_url', target: kind === 'mobile_url' ? 'mobile' : 'server', url } : selected ? { type: 'open_app', target: kind, appId: selected.id, appName: selected.name } : null;
  const valid = sanitizeGestureStep(candidate);
  return <View style={s.editor}>
    <Text style={s.editorTitle}>{initial ? 'Edit action' : 'Add action'}</Text>
    <View style={s.kinds}>{kinds.map(item => <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected: kind === item.id, disabled: unavailableKind(item.id) }} disabled={unavailableKind(item.id)} onPress={() => { if (item.id !== kind) setSelected(null); setKind(item.id); }} style={[s.kind, kind === item.id && s.selected, unavailableKind(item.id) && s.disabled]}><Text style={s.kindText}>{item.label}</Text></Pressable>)}</View>
    {kind === 'system' && <View style={s.builtins}>{builtins.map(value => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: action === value }} onPress={() => setAction(value)} style={[s.builtin, action === value && s.selected]}><Text style={s.kindText}>{actionNames[value]}</Text></Pressable>)}</View>}
    {(kind === 'mobile' || kind === 'server') && <GestureApplicationPicker key={kind === 'server' ? `server/${serverCatalogKey ?? ''}` : 'mobile'} target={kind} selected={selected} onSelect={setSelected} loadApps={kind === 'mobile' ? loadPhoneApps : loadServerApps} />}
    {kind === 'mobile' && <Text style={s.description}>In the background, this step posts a notification to open the phone app. Later actions continue without waiting for your tap.</Text>}
    {kind === 'command' && <View style={s.commandArea}><TextInput accessibilityLabel="Command to run on Mac" placeholder="Enter a shell command" placeholderTextColor={t.dim} value={command} onChangeText={setCommand} multiline autoCapitalize="none" autoCorrect={false} maxLength={4096} textAlignVertical="top" style={s.commandInput} /><Text style={s.description}>Runs on your Mac using zsh. The next action waits for the command to finish.</Text></View>}
    {editingUrl && <View style={s.commandArea}>
      <TextInput accessibilityLabel={`URL to open on ${kind === 'mobile_url' ? 'Phone' : 'Mac'}`} placeholder="https://example.com" placeholderTextColor={t.dim} value={url} onChangeText={setUrl} keyboardType="url" autoCapitalize="none" autoCorrect={false} selectTextOnFocus style={s.urlInput} />
      {!!url.trim() && !valid && <Text accessibilityLiveRegion="polite" style={s.error}>{url.trim().length > MAX_OPEN_URL_LENGTH ? `Use a URL with ${MAX_OPEN_URL_LENGTH.toLocaleString()} characters or fewer.` : 'Enter a full http:// or https:// URL without spaces or sign-in details.'}</Text>}
      <Text style={s.description}>Opens using {kind === 'mobile_url' ? "your phone's" : "your Mac's"} default browser or URL handler. The next action continues once the URL is handed off; it does not wait for the page to load.</Text>
      {kind === 'mobile_url' && Platform.OS === 'android' && <Text style={s.description}>In the background, this step posts a notification to open the URL. Later actions continue without waiting for your tap.</Text>}
    </View>}
    <View style={s.editorButtons}><Pressable accessibilityRole="button" onPress={onCancel} style={s.cancel}><Text style={s.kindText}>Cancel</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel={initial ? 'Save gesture action' : 'Add selected gesture action'} disabled={!valid} onPress={() => { if (valid) onSave(valid); }} style={[s.save, !valid && s.disabled]}><Text style={s.addText}>{initial ? 'Save action' : 'Add action'}</Text></Pressable></View>
  </View>;
}
const s = StyleSheet.create({
  list: { gap: 10 }, description: { color: t.muted, fontSize: 11, lineHeight: 17 }, step: { borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 10, gap: 4 }, stepLabel: { gap: 4 }, stepName: { color: t.text, fontSize: 12, lineHeight: 18 }, commandPreview: { color: t.muted, fontFamily: t.mono, fontSize: 10 }, editHint: { color: t.accent, fontSize: 10 }, tools: { flexDirection: 'row', justifyContent: 'flex-end', gap: 5 }, tool: { minWidth: 40, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: t.raised }, toolText: { color: t.text, fontSize: 19 }, removeText: { color: t.error, fontSize: 21 }, disabled: { opacity: 0.35 }, add: { minHeight: 44, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: t.accent, backgroundColor: t.accentDark, borderRadius: 9 }, addText: { color: t.accent, fontSize: 12, fontWeight: '600' }, editor: { backgroundColor: t.bg, padding: 12, gap: 12, borderRadius: 10, borderColor: t.border, borderWidth: 1 }, editorTitle: { color: t.text, fontSize: 14, fontWeight: '600' }, kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, kind: { flexGrow: 1, flexBasis: '42%', minHeight: 44, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: t.border, borderRadius: 8, backgroundColor: t.surface }, kindText: { color: t.text, fontSize: 12, textAlign: 'center' }, selected: { borderColor: t.accent, backgroundColor: t.accentDark }, builtins: { gap: 6 }, builtin: { minHeight: 44, padding: 10, justifyContent: 'center', borderWidth: 1, borderColor: t.border, borderRadius: 8 }, commandArea: { gap: 8 }, error: { color: t.error, fontSize: 11, lineHeight: 17 }, urlInput: { minHeight: 48, color: t.text, fontSize: 13, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface }, commandInput: { minHeight: 112, maxHeight: 220, color: t.text, fontFamily: t.mono, fontSize: 12, lineHeight: 19, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface }, editorButtons: { flexDirection: 'row', gap: 8 }, cancel: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 44 }, save: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 44, borderRadius: 9, borderWidth: 1, borderColor: t.accent, backgroundColor: t.accentDark },
});
