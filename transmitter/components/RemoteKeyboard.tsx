import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { KeyboardController } from '../services/KeyboardController';
import type { Key, Modifier } from '../../shared/protocol';
import { ActionButton } from './Controls';
import { InputPressable } from './InputPressable';
import { theme as t } from './theme';

type KeySpec = { key: Key; label: string; shifted?: string; width?: number };
const pairs = (keys: string, shifted: string): KeySpec[] => [...keys].map((key, i) => ({ key: key as Key, label: key, shifted: shifted[i] }));
const rows: KeySpec[][] = [
  [{ key: 'escape', label: 'esc', width: 1.3 }, ...pairs('1234567890', '!@#$%^&*()'), { key: 'backspace', label: '⌫', width: 1.5 }],
  [{ key: 'tab', label: 'tab', width: 1.3 }, ...pairs('qwertyuiop', 'QWERTYUIOP')],
  [{ key: 'caps_lock', label: '⇪', width: 1.3 }, ...pairs('asdfghjkl', 'ASDFGHJKL'), { key: 'enter', label: '↵', width: 1.5 }],
  [...pairs('zxcvbnm', 'ZXCVBNM'), { key: 'comma', label: ',', shifted: '<' }, { key: 'period', label: '.', shifted: '>' }, { key: 'slash', label: '/', shifted: '?' }],
];
const symbols: KeySpec[] = [
  { key: 'backtick', label: '`', shifted: '~' }, { key: 'minus', label: '−', shifted: '_' }, { key: 'equal', label: '=', shifted: '+' },
  { key: 'bracket_left', label: '[', shifted: '{' }, { key: 'bracket_right', label: ']', shifted: '}' }, { key: 'backslash', label: '\\', shifted: '|' },
  { key: 'semicolon', label: ';', shifted: ':' }, { key: 'quote', label: "'", shifted: '"' },
];
const modifiers: { key: Modifier; label: string; name: string }[] = [{ key: 'control', label: '⌃', name: 'Control' }, { key: 'option', label: '⌥', name: 'Option' }, { key: 'command', label: '⌘', name: 'Command' }, { key: 'shift', label: '⇧', name: 'Shift' }];

export function RemoteKeyboard({ keyboard, connected, haptic, compact }: { keyboard: KeyboardController; connected: boolean; haptic: () => void; compact: boolean }) {
  const [, rerender] = useState(0);
  useEffect(() => keyboard.subscribe(() => rerender(n => n + 1)), [keyboard]);
  const [text, setText] = useState('');
  const [showExtra, setShowExtra] = useState(false);
  const mods = keyboard.getModifiers();
  const caps = keyboard.getCapsLock();
  const shifted = mods.includes('shift');
  const refresh = () => rerender(n => n + 1);
  const keyView = ({ key, label, shifted: alternate, width = 1 }: KeySpec) => <InputPressable key={key} enabled={connected} accessibilityRole="button" accessibilityLabel={key}
    onDown={() => { haptic(); keyboard.press(key); refresh(); }}
    onUp={() => { keyboard.release(key); refresh(); }}
    style={({ pressed }) => [s.key, { flex: width, height: compact ? 35 : 43 }, pressed && s.pressedKey, key === 'caps_lock' && caps && s.modActive]}>
    <Text style={[s.keyLabel, (label.length > 2) && { fontSize: 10 }]}>{/^[a-z]$/.test(label) ? (shifted !== caps ? label.toUpperCase() : label) : shifted && alternate ? alternate : label}</Text>
    {alternate && !shifted && <Text style={s.altLabel}>{alternate}</Text>}
  </InputPressable>;
  return <ScrollView contentContainerStyle={s.container} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
    <View style={s.heading}><Text style={s.eyebrow}>02 / KEYBOARD</Text><Pressable accessibilityRole="button" onPress={() => { keyboard.reset(); refresh(); }}><Text style={s.clear}>Release all ↗</Text></Pressable></View>
    {!compact && <View style={s.keyboardHero}><Text style={s.heroTitle}>Every key. At your fingertips.</Text><Text style={s.heroDescription}>Tap a modifier to hold it. Tap again to release.</Text></View>}
    <View style={s.keyArea}>
      {rows.map((row, i) => <View style={s.row} key={i}>{row.map(keyView)}</View>)}
      <View style={s.row}>{modifiers.map(m => <Pressable key={m.key} disabled={!connected} accessibilityRole="button" accessibilityLabel={m.name} accessibilityState={{ selected: mods.includes(m.key) }} onPress={() => { haptic(); keyboard.toggleModifier(m.key); refresh(); }} style={[s.modifier, mods.includes(m.key) && s.modActive]}><Text style={[s.modifierSymbol, mods.includes(m.key) && { color: t.accent }]}>{m.label}</Text><Text style={s.modifierName}>{m.name}</Text></Pressable>)}</View>
      <View style={s.row}>{keyView({ key: 'space', label: 'space', width: 4 })}{keyView({ key: 'left', label: '←' })}{keyView({ key: 'up', label: '↑' })}{keyView({ key: 'down', label: '↓' })}{keyView({ key: 'right', label: '→' })}</View>
    </View>
    <View style={s.quickRow}>{(['c', 'v', 'z', 'a'] as Key[]).map(k => <Pressable key={k} disabled={!connected} accessibilityRole="button" accessibilityLabel={`Command ${k.toUpperCase()}`} onPress={() => {
      haptic(); keyboard.shortcut(k, ['command']);
    }} style={s.shortcut}><Text style={s.shortcutText}>⌘ {k.toUpperCase()}</Text></Pressable>)}
      <Pressable accessibilityRole="button" onPress={() => setShowExtra(v => !v)} style={[s.shortcut, showExtra && s.modActive]}><Text style={s.shortcutText}>Fn / #</Text></Pressable></View>
    {showExtra && <View style={s.extra}><View style={s.row}>{symbols.map(keyView)}</View><View style={s.row}>{Array.from({ length: 6 }, (_, i) => keyView({ key: `f${i + 1}` as Key, label: `F${i + 1}` }))}</View><View style={s.row}>{Array.from({ length: 6 }, (_, i) => keyView({ key: `f${i + 7}` as Key, label: `F${i + 7}` }))}</View><View style={s.row}>{(['home', 'end', 'page_up', 'page_down', 'delete'] as Key[]).map(k => keyView({ key: k, label: k.replace('_', ' ') }))}</View></View>}
    <View style={s.compose}><Text style={s.composeLabel}>UNICODE & SPECIAL CHARACTERS</Text><View style={s.composeRow}><TextInput editable={connected} value={text} onChangeText={setText} placeholder="Compose text…" placeholderTextColor={t.dim} style={s.textInput} accessibilityLabel="Unicode text" maxLength={1024} multiline /><ActionButton title="Send ↗" disabled={!connected || !text} onPress={() => { keyboard.text(text); setText(''); }} /></View><Text style={s.composeHelp}>Use the keys above for shortcuts. Text is sent when you tap Send.</Text></View>
  </ScrollView>;
}
const s = StyleSheet.create({
  container: { paddingVertical: 5, gap: 15, flexGrow: 1 }, heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, eyebrow: { color: t.dim, fontFamily: t.mono, fontSize: 10, letterSpacing: 1.1 }, clear: { color: t.muted, fontSize: 11 }, keyboardHero: { paddingVertical: 15, gap: 8 }, heroTitle: { color: t.text, fontSize: 21, letterSpacing: -0.5 }, heroDescription: { color: t.muted, fontSize: 12 },
  keyArea: { gap: 7 }, row: { flexDirection: 'row', gap: 4 }, key: { backgroundColor: t.raised, borderRadius: 7, borderWidth: 1, borderColor: t.border, alignItems: 'center', justifyContent: 'center' }, keyLabel: { color: t.text, fontSize: 14 }, altLabel: { position: 'absolute', top: 3, right: 4, color: t.dim, fontSize: 7 }, pressedKey: { backgroundColor: t.accentDark, borderColor: t.accent },
  modifier: { flex: 1, backgroundColor: t.surface, borderRadius: 9, borderWidth: 1, borderColor: t.border, minHeight: 46, justifyContent: 'center', alignItems: 'center', flexDirection: 'row', gap: 7 }, modifierSymbol: { color: t.muted, fontSize: 18 }, modifierName: { color: t.muted, fontSize: 9 }, modActive: { backgroundColor: t.accentDark, borderColor: t.accent },
  quickRow: { flexDirection: 'row', gap: 7 }, shortcut: { flex: 1, minHeight: 37, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: t.border, borderRadius: 9 }, shortcutText: { color: t.muted, fontSize: 12 }, extra: { gap: 7 },
  compose: { borderTopWidth: 1, borderTopColor: t.border, paddingTop: 17, gap: 10 }, composeLabel: { color: t.dim, fontSize: 9, letterSpacing: 1, fontFamily: t.mono }, composeRow: { flexDirection: 'row', gap: 8 }, textInput: { flex: 1, minHeight: 46, maxHeight: 90, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 13, color: t.text, padding: 12, fontSize: 13 }, composeHelp: { color: t.dim, fontSize: 10 },
});
