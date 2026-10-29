import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { gestureBridge, type CalibrationTakeReadings, type GestureId } from '../modules/gesture-service';
import { CalibrationReadingsRequest, calibrationSeries, calibrationReadingsJson, calibrationTakeSummary, chartSamples, recognitionAxes, type CalibrationSeries, type ReadCalibrationReadings } from '../services/calibrationReadings';
import { gestureNames } from '../services/gestureSettings';
import { theme as t } from './theme';

const nativeRead: ReadCalibrationReadings | undefined = gestureBridge?.getCalibrationReadings
  ? (gesture, sessionId) => gestureBridge!.getCalibrationReadings!(gesture, sessionId) : undefined;
const axes = ['x', 'y', 'z'] as const;
const colors = { x: '#72d3ff', y: '#c4f58a', z: '#ffb878' };
const PAGE_SIZE = 25;
const fixed = (value: number, precision = 3) => value.toFixed(precision);

function ReadingsChart({ series, preparationMs, effectiveXY }: { series: CalibrationSeries; preparationMs: number; effectiveXY: boolean }) {
  const [width, setWidth] = useState(250);
  const height = 180;
  const points = useMemo(() => chartSamples(series.points), [series.points]);
  const low = Math.min(0, ...recognitionAxes.map(axis => series.ranges[axis].min));
  const high = Math.max(0, ...recognitionAxes.map(axis => series.ranges[axis].max));
  const padding = Math.max(0.05, (high - low) * 0.08);
  const min = low - padding, max = high + padding;
  const end = Math.max(1, series.points.at(-1)?.timeMs ?? 1);
  const y = (value: number) => (max - value) / (max - min) * height;
  const horizontal = (value: number) => series.horizontalUnit === 'ms' ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}`;
  return <View style={s.chartBox}>
    <Text style={s.label}>{series.unit === 'g' ? 'X/Y acceleration (g), including gravity' : effectiveXY ? 'Effective X/Y matching shape (unitless)' : 'Earlier template · X/Y view (unitless)'}</Text>
    <View style={s.legend}>{recognitionAxes.map(axis => <Text key={axis} style={[s.legendText, { color: colors[axis] }]}>{axis.toUpperCase()} ━</Text>)}</View>
    <View accessible accessibilityRole="image" accessibilityLabel={`X and Y graph. ${series.count} ${series.unit === 'g' ? 'sensor readings in g' : 'normalized samples'}. Z is not plotted. Axis ranges are listed below.`} style={s.chartRow}>
      <View style={s.yLabels}><Text style={s.axis}>{fixed(max, 2)}</Text><Text style={s.axis}>{fixed((min + max) / 2, 2)}</Text><Text style={s.axis}>{fixed(min, 2)}</Text></View>
      <View style={{ flex: 1 }}>
        <View onLayout={event => setWidth(Math.max(1, event.nativeEvent.layout.width))} style={[s.plot, { height }]}>
          {[0, height / 2, height].map(position => <View key={position} style={[s.gridLine, { top: Math.min(height - 1, position) }]} />)}
          {series.unit === 'g' && preparationMs > 0 && <View style={[s.preparation, { width: Math.min(1, preparationMs / end) * width, height }]} />}
          {points.length === 1 && recognitionAxes.map(axis => <View key={axis} style={{ position: 'absolute', left: 0, top: y(points[0]![axis]) - 2, width: 4, height: 4, borderRadius: 2, backgroundColor: colors[axis] }} />)}
          {recognitionAxes.flatMap(axis => points.slice(1).map((point, index) => {
            const previous = points[index]!;
            const x1 = previous.timeMs / end * width, x2 = point.timeMs / end * width;
            const y1 = y(previous[axis]), y2 = y(point[axis]);
            const length = Math.hypot(x2 - x1, y2 - y1);
            return <View key={`${axis}-${index}`} style={{ position: 'absolute', left: (x1 + x2) / 2 - length / 2, top: (y1 + y2) / 2 - 0.75, width: Math.max(1, length), height: 1.5, backgroundColor: colors[axis], transform: [{ rotate: `${Math.atan2(y2 - y1, x2 - x1)}rad` }] }} />;
          }))}
        </View>
        <View style={s.xLabels}><Text style={s.axis}>{horizontal(0)}</Text><Text style={s.axis}>{horizontal(end / 2)}</Text><Text style={s.axis}>{horizontal(end)}</Text></View>
      </View>
    </View>
    <Text style={s.note}>{series.horizontalUnit === 'ms' ? `Time from first sensor frame · shaded first ${(preparationMs / 1000).toFixed(2)}s = preparation` : 'Uniform template sample index · not original sensor timestamps'}</Text>
    {points.length < series.count && <Text style={s.note}>Graph uses {points.length} points and retains local X/Y peaks. All {series.count} readings remain in the table and JSON.</Text>}
  </View>;
}

function takeSummary(take: CalibrationTakeReadings) {
  const summary = calibrationTakeSummary(take);
  if (!summary) return { duration: '—', span: 'Unavailable' };
  return { duration: summary.durationMs === null ? '—' : `${(summary.durationMs / 1000).toFixed(2)}s${summary.durationKind === 'capture' ? ' capture' : ''}`, span: `${summary.largestSpan.toFixed(3)} ${summary.unit === 'g' ? 'g' : 'norm.'}` };
}

/** Content for the existing calibration modal; viewing never starts or ends its guard. */
export function CalibrationReadingsInspector({ gestures, sessionId, profileRevision, onBack, read = nativeRead }: {
  gestures: GestureId[]; sessionId: string | null; profileRevision: number; onBack: () => void; read?: ReadCalibrationReadings;
}) {
  const [selected, setSelected] = useState<GestureId | undefined>(gestures[0]);
  const gesture = selected && gestures.includes(selected) ? selected : gestures[0];
  const [takeNumber, setTakeNumber] = useState(1);
  const [preferredMode, setPreferredMode] = useState<'raw' | 'template'>('raw');
  const [table, setTable] = useState(false);
  const [page, setPage] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [notice, setNotice] = useState('');
  const [, update] = useState(0);
  const alive = useRef(true);
  const shareGeneration = useRef(0);
  const request = useMemo(() => new CalibrationReadingsRequest(read, () => { if (alive.current) update(value => value + 1); }), [read, gesture, sessionId, profileRevision]);
  useEffect(() => {
    alive.current = true;
    setSharing(false); setNotice(''); setPage(0);
    if (gesture) void request.load(gesture, sessionId, profileRevision);
    return () => { alive.current = false; ++shareGeneration.current; request.cancel(); };
  }, [request, gesture, sessionId, profileRevision]);
  const { loading, data, error } = request.snapshot;
  const effectiveXY = data?.recognitionAxes?.[0] === 'x' && data.recognitionAxes[1] === 'y';
  const take = data?.takes.find(value => value.take === takeNumber) ?? data?.takes[0];
  const mode = take?.raw?.length ? preferredMode === 'template' && take.template ? 'template' : 'raw' : 'template';
  const series = useMemo(() => take ? calibrationSeries(take, mode) : null, [take, mode]);
  const chooseGesture = (next: GestureId) => {
    if (next === gesture) return;
    request.cancel(); ++shareGeneration.current; setSelected(next); setTakeNumber(1); setPage(0); setTable(false); setPreferredMode('raw'); setNotice(''); setSharing(false);
  };
  const back = () => { request.cancel(); ++shareGeneration.current; onBack(); };
  const share = async () => {
    if (!data || sharing) return;
    const generation = ++shareGeneration.current;
    setSharing(true); setNotice('');
    try { await Share.share({ title: `${gestureNames[data.gesture]} · calibration readings`, message: calibrationReadingsJson(data) }); }
    catch { if (alive.current && generation === shareGeneration.current) setNotice('Could not open sharing. Try again.'); }
    finally { if (alive.current && generation === shareGeneration.current) setSharing(false); }
  };
  const pages = Math.max(1, Math.ceil((series?.count ?? 0) / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  return <View style={s.content}>
    <Pressable accessibilityRole="button" accessibilityLabel="Back to calibration" onPress={back} style={s.button}><Text style={s.buttonText}>← Back to calibration</Text></Pressable>
    <Text style={s.title}>{sessionId === null ? 'Saved take readings' : 'Recorded takes · not saved yet'}</Text>
    <Text style={s.body}>Compare the X/Y movement you recorded. Viewing or sharing readings does not change recognition.</Text>
    {data && <Text style={s.body}>{effectiveXY ? 'With the phone upright, X is left/right and Y is up/down. Recognition ignores Z, the depth toward or away from you. Original Z readings remain in the table and JSON for reference.' : 'This earlier app response does not identify its recognition axes. The graph shows X/Y; update the Android app to inspect the effective XY matching shape. Original XYZ readings remain in the table and JSON.'}</Text>}
    <Text style={s.label}>Movement</Text>
    <View style={s.chips}>{gestures.map(id => <Pressable key={id} accessibilityRole="tab" accessibilityLabel={`Readings for ${gestureNames[id]}`} accessibilityState={{ selected: gesture === id }} onPress={() => chooseGesture(id)} style={[s.chip, gesture === id && s.selected]}><Text style={[s.chipText, gesture === id && s.selectedText]}>{gestureNames[id]}</Text></Pressable>)}</View>
    {loading && <Text accessibilityLiveRegion="polite" style={s.body}>Reading takes…</Text>}
    {!!error && <View style={s.card}><Text accessibilityLiveRegion="polite" style={s.error}>{error}</Text><Pressable accessibilityRole="button" onPress={() => { if (gesture) void request.load(gesture, sessionId, profileRevision); }} style={s.button}><Text style={s.buttonText}>Try again</Text></Pressable></View>}
    {!loading && !error && (!gesture || data?.takes.length === 0) && <Text style={s.body}>No recorded takes are available for this movement.</Text>}
    {data && take && <>
      <Text style={s.label}>Take</Text>
      <View style={s.chips}>{data.takes.map(value => <Pressable key={value.take} accessibilityRole="tab" accessibilityLabel={`View take ${value.take}`} accessibilityState={{ selected: take.take === value.take }} onPress={() => { setTakeNumber(value.take); setPage(0); setNotice(''); }} style={[s.chip, take.take === value.take && s.selected]}><Text style={[s.chipText, take.take === value.take && s.selectedText]}>{value.take}</Text></Pressable>)}</View>
      {!take.raw?.length && <Text style={s.body}>Original readings weren’t retained for this earlier take. The graph shows its normalized matching shape, not measured acceleration.</Text>}
      {take.raw?.length && take.template ? <View style={s.chips}>{(['raw', 'template'] as const).map(value => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: mode === value }} onPress={() => { setPreferredMode(value); setPage(0); }} style={[s.chip, mode === value && s.selected]}><Text style={[s.chipText, mode === value && s.selectedText]}>{value === 'raw' ? 'Raw readings · g' : 'Matching shape'}</Text></Pressable>)}</View> : null}
      {series ? <>
        <ReadingsChart series={series} preparationMs={data.preparationMs} effectiveXY={effectiveXY} />
        <View style={s.card}><Text style={s.label}>{series.count} {mode === 'raw' ? 'sensor readings' : 'normalized samples'} · take {take.take}</Text>
          {mode === 'raw' && <Text style={s.note}>Full capture: {((series.elapsedMs ?? 0) / 1000).toFixed(2)}s, including {(data.preparationMs / 1000).toFixed(2)}s preparation.</Text>}
          {recognitionAxes.map(axis => <Text key={axis} style={s.value}>{axis.toUpperCase()}: {fixed(series.ranges[axis].min)} to {fixed(series.ranges[axis].max)} {mode === 'raw' ? 'g' : '(unitless)'}</Text>)}
          <Text style={s.note}>Z {effectiveXY ? '(ignored)' : '(not plotted)'}: {fixed(series.ranges.z.min)} to {fixed(series.ranges.z.max)} {mode === 'raw' ? 'g' : '(unitless)'}</Text>
          {take.template && <Text style={s.note}>{effectiveXY ? 'Effective XY shape' : 'Earlier template'} v{take.template.modelVersion} · duration {take.template.durationMs}ms · {effectiveXY ? 'XY amplitude' : 'amplitude'} {fixed(take.template.amplitudeG)}g · distance limit {take.template.maxDistance}.</Text>}
          {effectiveXY && take.template?.source && <Text style={s.note}>{take.template.source === 'raw_rebuilt' ? `Rebuilt for XY from the original readings of saved model v${take.template.storedModelVersion}.` : take.template.source === 'projected' ? `Converted to XY from the earlier normalized model v${take.template.storedModelVersion}.` : take.template.source === 'draft' ? 'XY shape from this recorded take; not saved yet.' : 'Saved XY matching shape.'} Original recordings are unchanged.</Text>}
        </View>
      <View style={s.card}>
        <Text style={s.label}>Compare takes</Text>
        <View style={s.comparisonRow}><Text style={[s.note, s.takeColumn]}>Take</Text><Text style={[s.note, s.durationColumn]}>Movement</Text><Text style={[s.note, s.spanColumn]}>Largest X/Y span</Text></View>
        {data.takes.map(value => { const summary = takeSummary(value); return <Pressable key={value.take} accessibilityRole="button" accessibilityLabel={`Select take ${value.take}, duration ${summary.duration}, largest X or Y span ${summary.span}`} onPress={() => { setTakeNumber(value.take); setPage(0); }} style={[s.comparisonRow, take.take === value.take && s.comparisonSelected]}><Text style={[s.value, s.takeColumn]}>{value.take}</Text><Text style={[s.value, s.durationColumn]}>{summary.duration}</Text><Text style={[s.value, s.spanColumn]}>{summary.span}</Text></Pressable>; })}
        <Text style={s.note}>Movement = matching-shape duration. Without a shape, the full duration is marked capture. Span = largest X or Y range; Z is excluded and normalized values are unitless.</Text>
      </View>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: table }} onPress={() => setTable(value => !value)} style={s.button}><Text style={s.buttonText}>{table ? 'Hide reading table' : 'Show reading table'}</Text></Pressable>
        {table && <View style={s.card}>
          <Text style={s.note}>Values rounded to 4 decimals. JSON retains the precision returned by the sensor service.</Text>
          <View style={s.tableRow}>{[mode === 'raw' ? 'Time (ms)' : 'Sample', 'X', 'Y', effectiveXY ? 'Z ignored' : 'Z'].map(label => <Text key={label} style={[s.cell, s.note]}>{label}</Text>)}</View>
          {series.points.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((point, index) => <View key={`${currentPage}-${index}`} style={s.tableRow}><Text selectable style={s.cell}>{mode === 'raw' ? fixed(point.timeMs, 4) : point.timeMs}</Text>{axes.map(axis => <Text selectable key={axis} style={s.cell}>{fixed(point[axis], 4)}</Text>)}</View>)}
          <Text style={s.note}>Rows {currentPage * PAGE_SIZE + 1}–{Math.min(series.count, (currentPage + 1) * PAGE_SIZE)} of {series.count} · {mode === 'raw' ? 'XYZ in g, including gravity' : 'XYZ normalized, unitless'}</Text>
          <View style={s.pagination}><Pressable accessibilityRole="button" disabled={currentPage === 0} onPress={() => setPage(currentPage - 1)} style={[s.button, currentPage === 0 && s.disabled]}><Text style={s.buttonText}>Previous</Text></Pressable><Pressable accessibilityRole="button" disabled={currentPage === pages - 1} onPress={() => setPage(currentPage + 1)} style={[s.button, currentPage === pages - 1 && s.disabled]}><Text style={s.buttonText}>Next</Text></Pressable></View>
        </View>}
      </> : <Text style={s.body}>No usable readings are available for this take.</Text>}
      <Pressable accessibilityRole="button" disabled={sharing} onPress={() => { void share(); }} style={[s.button, sharing && s.disabled]}><Text style={s.buttonText}>{sharing ? 'Opening share sheet…' : 'Share all takes · JSON'}</Text></Pressable>
      <Text style={s.note}>Exports all {data.takes.length} takes for this movement, including original XYZ readings and matching shapes when available, with source, preparation time, model version and recognition axes when reported.</Text>
    </>}
    {!!notice && <Text accessibilityLiveRegion="polite" style={s.error}>{notice}</Text>}
  </View>;
}

const s = StyleSheet.create({
  content: { gap: 14 }, title: { color: t.text, fontSize: 22, fontWeight: '600' }, body: { color: t.muted, fontSize: 13, lineHeight: 20 }, note: { color: t.muted, fontSize: 10, lineHeight: 15 }, label: { color: t.text, fontSize: 13, fontWeight: '600' }, value: { color: t.text, fontSize: 11, fontFamily: t.mono },
  card: { backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, borderRadius: 14, padding: 13, gap: 9 }, chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, chip: { minHeight: 44, minWidth: 44, borderRadius: 10, borderWidth: 1, borderColor: t.border, paddingHorizontal: 12, paddingVertical: 10, justifyContent: 'center', alignItems: 'center' }, selected: { borderColor: t.accent, backgroundColor: t.accentDark }, chipText: { color: t.muted, fontSize: 12 }, selectedText: { color: t.accent },
  button: { minHeight: 46, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 13, paddingVertical: 10, borderWidth: 1, borderColor: t.border, borderRadius: 11, backgroundColor: t.surface }, buttonText: { color: t.accent, fontSize: 12, fontWeight: '600', textAlign: 'center' }, disabled: { opacity: 0.45 }, error: { color: t.error, fontSize: 12, lineHeight: 18 },
  chartBox: { gap: 10, paddingVertical: 10 }, legend: { flexDirection: 'row', gap: 24 }, legendText: { fontSize: 12, fontWeight: '600' }, chartRow: { flexDirection: 'row', gap: 6 }, yLabels: { width: 38, height: 180, justifyContent: 'space-between', alignItems: 'flex-end' }, axis: { color: t.muted, fontSize: 9, fontFamily: t.mono }, plot: { position: 'relative', overflow: 'hidden', borderWidth: 1, borderColor: t.border }, gridLine: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: t.border }, preparation: { position: 'absolute', left: 0, top: 0, backgroundColor: '#ffffff0d', borderRightWidth: 1, borderColor: t.muted }, xLabels: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 6 },
  comparisonRow: { flexDirection: 'row', gap: 6, minHeight: 34, alignItems: 'center', paddingVertical: 5 }, comparisonSelected: { backgroundColor: t.accentDark, borderRadius: 5 }, takeColumn: { width: 35 }, durationColumn: { width: 65 }, spanColumn: { flex: 1 }, tableRow: { flexDirection: 'row', borderBottomWidth: 1, borderColor: t.border, paddingVertical: 6 }, cell: { flex: 1, color: t.text, fontSize: 10, fontFamily: t.mono, textAlign: 'right' }, pagination: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
});
