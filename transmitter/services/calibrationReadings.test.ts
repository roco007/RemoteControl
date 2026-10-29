import { describe, expect, it } from 'vitest';
import type { CalibrationReadings, CalibrationTakeReadings } from '../modules/gesture-service';
import { calibrationSeries, chartSamples, calibrationReadingsJson, calibrationTakeSummary, draftReadingsGestures, CalibrationReadingsRequest } from './calibrationReadings';
const rawTake: CalibrationTakeReadings = { take: 1, raw: [{ timeMs: 0, x: 0, y: 0, z: 1 }, { timeMs: 1200, x: -0.75, y: 0.2, z: 0.8 }, { timeMs: 7700, x: 0, y: 0, z: 1 }], template: null };
const data = (gesture: CalibrationReadings['gesture'] = 'left', overrides: Partial<CalibrationReadings> = {}): CalibrationReadings => ({ gesture, source: 'saved', sessionId: null, profileRevision: 4, preparationMs: 1200, takes: [rawTake], ...overrides });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
describe('calibration readings data', () => {
  it('keeps raw g, gravity, and capture-relative time without normalization', () => {
    const series = calibrationSeries(rawTake, 'raw');
    expect(series).toMatchObject({ unit: 'g', horizontalUnit: 'ms', elapsedMs: 7700, count: 3, ranges: { x: { min: -0.75, max: 0 }, z: { min: 0.8, max: 1 } } });
    expect(series?.points).toEqual(rawTake.raw);
  });
  it('presents legacy normalized templates by sample index without inventing raw times or g', () => {
    const legacy: CalibrationTakeReadings = { take: 7, raw: null, template: { points: [{ x: -1, y: 0.5, z: 0 }, { x: 1, y: -0.5, z: 0 }], durationMs: 450, amplitudeG: 1.8, modelVersion: 1, maxDistance: 0.25 } };
    expect(calibrationSeries(legacy, 'raw')).toBeNull();
    expect(calibrationSeries(legacy, 'template')).toMatchObject({ unit: 'normalized', horizontalUnit: 'sample', elapsedMs: null, count: 2, points: [{ timeMs: 0, x: -1, y: 0.5, z: 0 }, { timeMs: 1, x: 1, y: -0.5, z: 0 }] });
  });
  it('bounds the chart while preserving chronology, endpoints, and narrow X/Y spikes', () => {
    const readings = Array.from({ length: 1000 }, (_, i) => ({ timeMs: i * 8, x: 0, y: 0, z: 1 }));
    readings[9]!.x = 8; readings[287]!.y = -6; readings[999]!.z = 0.1;
    const chart = chartSamples(readings);
    expect(chart.length).toBeLessThanOrEqual(220);
    expect(chart[0]).toEqual(readings[0]); expect(chart.at(-1)).toEqual(readings.at(-1));
    expect(chart).toContainEqual(readings[9]); expect(chart).toContainEqual(readings[287]);
    expect(chart.every((point, i) => i === 0 || point.timeMs > chart[i - 1]!.timeMs)).toBe(true);
    expect(readings).toHaveLength(1000);
  });
  it('does not let depth change which X/Y readings the graph retains or their comparison span', () => {
    const flat = Array.from({ length: 1000 }, (_, i) => ({ timeMs: i * 8, x: Math.sin(i / 10), y: Math.cos(i / 13), z: 0 }));
    const depth = flat.map((point, i) => ({ ...point, z: i % 7 === 0 ? 80 : -12 }));
    const planar = (points: typeof flat) => points.map(({ timeMs, x, y }) => ({ timeMs, x, y }));
    expect(planar(chartSamples(depth))).toEqual(planar(chartSamples(flat)));
    expect(calibrationTakeSummary({ take: 1, raw: depth, template: null })).toEqual(calibrationTakeSummary({ take: 1, raw: flat, template: null }));
    expect(calibrationTakeSummary({ take: 1, raw: depth, template: null })?.largestSpan).toBeLessThanOrEqual(2);
  });
  it('does not graph invalid readings or make up data for an empty take', () => {
    expect(calibrationSeries({ take: 1, raw: [], template: null }, 'raw')).toBeNull();
    expect(calibrationSeries({ ...rawTake, raw: [{ timeMs: 0, x: NaN, y: 0, z: 1 }] }, 'raw')).toBeNull();
    expect(calibrationSeries({ ...rawTake, raw: [...rawTake.raw!].reverse() }, 'raw')).toBeNull();
  });
  it('exports every take at returned precision with explicit units and preparation metadata', () => {
    const readings = data('left', { takes: [rawTake, { take: 2, raw: null, template: { points: [{ x: 0.123456789, y: 0, z: 1 }], durationMs: 300, amplitudeG: 0.987654321, modelVersion: 2, maxDistance: 0.25 } }] });
    const exported = JSON.parse(calibrationReadingsJson(readings));
    expect(exported).toMatchObject({ gesture: 'left', source: 'saved', profileRevision: 4, preparationMs: 1200, units: { raw: 'g including gravity', rawTime: 'milliseconds from first sensor frame', template: 'normalized unitless values' }, takes: readings.takes });
    expect(exported.takes[0].raw).toEqual(rawTake.raw);
    expect(exported.takes[1].template.points[0].x).toBe(0.123456789);
    expect(exported).not.toHaveProperty('recognitionAxes');
  });
  it('exports effective XY provenance without discarding original depth readings', () => {
    const readings = data('left', { recognitionAxes: ['x', 'y'], takes: [{ ...rawTake, template: { points: [{ x: 0.123456789, y: -0.333333333, z: 0 }], durationMs: 450, amplitudeG: 0.8, modelVersion: 3, storedModelVersion: 2, source: 'raw_rebuilt', maxDistance: 0.25 } }] });
    const exported = JSON.parse(calibrationReadingsJson(readings));
    expect(exported.recognitionAxes).toEqual(['x', 'y']);
    expect(exported.takes[0].template).toEqual(readings.takes[0]!.template);
    expect(exported.takes[0].raw).toEqual(rawTake.raw);
    expect(exported.takes[0].raw[0].z).toBe(1);
  });
  it('offers only draft movements with at least one accepted take', () => {
    expect(draftReadingsGestures({ gestures: ['left', 'right', 'single'], repetitions: 5, accepted: 6 })).toEqual(['left', 'right']);
    expect(draftReadingsGestures({ gestures: ['right'], repetitions: 5, accepted: 0 })).toEqual([]);
  });
  it('compares movement duration when available and labels full-capture fallback separately', () => {
    const take = { ...rawTake, template: { points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], durationMs: 450, amplitudeG: 0.8, modelVersion: 2, maxDistance: 0.25 } };
    expect(calibrationTakeSummary(take)).toMatchObject({ durationMs: 450, durationKind: 'movement', largestSpan: 0.75, unit: 'g' });
    expect(calibrationTakeSummary(rawTake)).toMatchObject({ durationMs: 7700, durationKind: 'capture', unit: 'g' });
    expect(calibrationTakeSummary({ ...take, raw: null })).toMatchObject({ durationMs: 450, durationKind: 'movement', largestSpan: 1, unit: 'normalized' });
  });
});
describe('readings request ownership', () => {
  it('accepts confirmed XY conversion metadata and keeps older unreported axes distinct', async () => {
    const old = data('left', { takes: [{ ...rawTake, template: { points: [{ x: 0.2, y: -0.3, z: 0.7 }], durationMs: 450, amplitudeG: 0.8, modelVersion: 2, maxDistance: 0.25 } }] });
    const current = data('left', { recognitionAxes: ['x', 'y'], takes: [{ ...old.takes[0]!, template: { ...old.takes[0]!.template!, points: [{ x: 0.4, y: -0.6, z: 0 }], modelVersion: 3, storedModelVersion: 2, source: 'projected' } }] });
    const request = new CalibrationReadingsRequest(async () => current, () => {});
    await request.load('left', null, 4);
    expect(request.snapshot.data).toEqual(current);
    const legacy = new CalibrationReadingsRequest(async () => old, () => {});
    await legacy.load('left', null, 4);
    expect(legacy.snapshot.data).toEqual(old);
    expect(legacy.snapshot.data?.recognitionAxes).toBeUndefined();
  });
  it('ignores the old movement response after selection changes', async () => {
    const old = deferred<CalibrationReadings>(); const next = deferred<CalibrationReadings>();
    const request = new CalibrationReadingsRequest(gesture => gesture === 'left' ? old.promise : next.promise, () => {});
    const first = request.load('left', null, 4); const second = request.load('right', null, 4);
    next.resolve(data('right')); await second; old.resolve(data('left')); await first;
    expect(request.snapshot.data?.gesture).toBe('right');
  });
  it('fences late results and errors after closing', async () => {
    const pending = deferred<CalibrationReadings>(); const request = new CalibrationReadingsRequest(() => pending.promise, () => {});
    const loading = request.load('left', 'draft-one', 4); request.cancel(); pending.reject(Error('Late failure')); await loading;
    expect(request.snapshot).toEqual({ loading: false, data: null, error: '' });
  });
  it('rejects another draft session or saved profile', async () => {
    const request = new CalibrationReadingsRequest(async () => data('left', { source: 'draft', sessionId: 'old' }), () => {});
    await request.load('left', 'new', 4);
    expect(request.snapshot.data).toBeNull(); expect(request.snapshot.error).not.toBe('');
    const saved = new CalibrationReadingsRequest(async () => data('left', { profileRevision: 5 }), () => {});
    await saved.load('left', null, 4); expect(saved.snapshot.data).toBeNull();
  });
  it('explains an older native build without the readings API', async () => {
    const request = new CalibrationReadingsRequest(undefined, () => {});
    await request.load('left', null, 4);
    expect(request.snapshot.error).toMatch(/update/i); expect(request.snapshot.loading).toBe(false);
  });
});
