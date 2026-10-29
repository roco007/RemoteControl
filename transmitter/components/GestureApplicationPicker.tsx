import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { filterApplications, sanitizeApplications, type InstalledApplication } from '../services/applicationCatalog';
import { theme as t } from './theme';

export function GestureApplicationPicker({ target, selected, onSelect, loadApps }: {
  target: 'mobile' | 'server'; selected: InstalledApplication | null;
  onSelect: (app: InstalledApplication) => void; loadApps: () => Promise<InstalledApplication[]>;
}) {
  const [apps, setApps] = useState<InstalledApplication[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const loader = useRef(loadApps); loader.current = loadApps;
  const source = target === 'mobile' ? 'this phone' : 'your Mac';
  useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    void loader.current().then(value => {
      const next = sanitizeApplications(value);
      if (alive) setApps(next);
    }).catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : `Could not load apps from ${source}.`); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [target, revision]);
  const matches = filterApplications(apps, query);
  return <View style={s.container}>
    <Text style={s.label}>Apps on {source}</Text>
    <TextInput accessibilityLabel={`Search apps on ${source}`} placeholder="Start typing an app name" placeholderTextColor={t.dim} value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} style={s.input} />
    {selected && <Text style={s.selectedName}>Selected: {selected.name}</Text>}
    <View style={s.bar}><Text style={s.hint} accessibilityLiveRegion="polite">{loading ? 'Loading installed apps…' : `${matches.length} ${matches.length === 1 ? 'app' : 'apps'}`}</Text><Pressable accessibilityRole="button" accessibilityLabel={`Refresh apps on ${source}`} disabled={loading} onPress={() => setRevision(value => value + 1)} style={s.refresh}>{loading ? <ActivityIndicator color={t.accent} size="small" /> : <Text style={s.link}>Refresh</Text>}</Pressable></View>
    {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={s.list}>
      {matches.map(app => <Pressable key={app.id} accessibilityRole="button" accessibilityLabel={`Select ${app.name} on ${source}`} accessibilityState={{ selected: selected?.id === app.id }} onPress={() => onSelect(app)} style={[s.option, selected?.id === app.id && s.selected]}>
        {app.icon ? <Image source={{ uri: app.icon }} style={s.icon} resizeMode="contain" /> : <View style={s.placeholder}><Text style={s.placeholderText}>{app.name.slice(0, 1).toLocaleUpperCase()}</Text></View>}
        <Text style={s.appName} numberOfLines={2}>{app.name}</Text>{selected?.id === app.id && <Text style={s.link}>✓</Text>}
      </Pressable>)}
      {!loading && !matches.length && !error && <Text style={s.empty}>{apps.length ? 'No matching apps. Try another name.' : 'No launchable apps found. Refresh to check again.'}</Text>}
    </ScrollView>
  </View>;
}
const s = StyleSheet.create({
  container: { gap: 8 }, label: { color: t.text, fontSize: 13, fontWeight: '500' }, input: { color: t.text, backgroundColor: t.bg, borderColor: t.border, borderWidth: 1, borderRadius: 9, minHeight: 46, paddingHorizontal: 12, fontSize: 13 },
  selectedName: { color: t.accent, fontSize: 12 }, bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, hint: { color: t.muted, fontSize: 11 }, refresh: { minHeight: 40, minWidth: 65, justifyContent: 'center', alignItems: 'flex-end' }, link: { color: t.accent, fontSize: 12 }, error: { color: t.warning, fontSize: 12, lineHeight: 18 }, list: { maxHeight: 230, borderRadius: 9, borderWidth: 1, borderColor: t.border },
  option: { padding: 10, minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 10 }, selected: { backgroundColor: t.accentDark }, icon: { width: 30, height: 30 }, placeholder: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', backgroundColor: t.raised, borderRadius: 7 }, placeholderText: { color: t.muted, fontSize: 15 }, appName: { flex: 1, color: t.text, fontSize: 13 }, empty: { padding: 12, color: t.muted, fontSize: 12, lineHeight: 18 },
});
