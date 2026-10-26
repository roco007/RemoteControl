import React from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { theme as t } from './theme';

export function ActionButton({ title, onPress, primary = false, disabled = false, style }: {
  title: string; onPress: () => void; primary?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [s.button, primary && s.primary, disabled && s.disabled, pressed && s.pressed, style]}>
    <Text style={[s.label, primary && { color: t.bg }]}>{title}</Text>
  </Pressable>;
}

export function SettingStepper({ title, detail, value, onChange }: { title: string; detail: string; value: number; onChange: (value: number) => void }) {
  return <View style={s.setting}><View style={{ flex: 1 }}><Text style={s.settingTitle}>{title}</Text><Text style={s.detail}>{detail}</Text></View>
    <View style={s.stepper}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Decrease ${title}`} onPress={() => onChange(Math.max(0.2, Math.round((value - 0.2) * 10) / 10))} style={s.step}><Text style={s.stepText}>−</Text></Pressable>
      <Text style={s.value}>{value.toFixed(1)}×</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Increase ${title}`} onPress={() => onChange(Math.min(3, Math.round((value + 0.2) * 10) / 10))} style={s.step}><Text style={s.stepText}>+</Text></Pressable>
    </View>
  </View>;
}
const s = StyleSheet.create({
  button: { minHeight: 46, borderRadius: 13, backgroundColor: t.raised, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: t.border },
  primary: { backgroundColor: t.accent, borderColor: t.accent }, disabled: { opacity: 0.4 }, pressed: { opacity: 0.7 }, label: { color: t.text, fontSize: 14, fontWeight: '600' },
  setting: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 15 }, settingTitle: { color: t.text, fontSize: 14, fontWeight: '500' }, detail: { color: t.muted, fontSize: 12, marginTop: 4 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 7 }, step: { width: 32, height: 36, borderRadius: 9, backgroundColor: t.raised, alignItems: 'center', justifyContent: 'center' }, stepText: { color: t.text, fontSize: 20 }, value: { width: 40, textAlign: 'center', color: t.accent, fontFamily: t.mono, fontSize: 12 },
});
