import type { CalibrationReadings, CalibrationRawReading, CalibrationTakeReadings, GestureCalibrationStatus, GestureId } from '../modules/gesture-service';
export interface CalibrationSeries { unit: 'g' | 'normalized'; horizontalUnit: 'ms' | 'sample'; elapsedMs: number | null; count: number; points: CalibrationRawReading[]; ranges: Record<'x' | 'y' | 'z', { min: number; max: number }> }
const axes = ['x', 'y', 'z'] as const;
export const recognitionAxes = ['x', 'y'] as const;
export function calibrationSeries(take: CalibrationTakeReadings, mode: 'raw' | 'template'): CalibrationSeries | null {
  const points = mode === 'raw' ? take.raw : take.template?.points.map((point, index) => ({ ...point, timeMs: index }));
  if (!points?.length || points.some((point, index) => !Number.isFinite(point.timeMs) || point.timeMs < 0 || axes.some(axis => !Number.isFinite(point[axis])) || (index > 0 && point.timeMs < points[index - 1]!.timeMs))) return null;
  const range = (axis: typeof axes[number]) => points.reduce((value, point) => ({ min: Math.min(value.min, point[axis]), max: Math.max(value.max, point[axis]) }), { min: Infinity, max: -Infinity });
  return { unit: mode === 'raw' ? 'g' : 'normalized', horizontalUnit: mode === 'raw' ? 'ms' : 'sample', elapsedMs: mode === 'raw' ? points.at(-1)!.timeMs : null, count: points.length, points, ranges: { x: range('x'), y: range('y'), z: range('z') } };
}
/** Keep each bucket's X/Y extrema; ignored depth cannot change the visible sample selection. */
export function chartSamples(readings: CalibrationRawReading[]): CalibrationRawReading[] {
  if (readings.length <= 220) return readings;
  const indices = new Set([0, readings.length - 1]);
  const buckets = 54; // At most four extrema per bucket, plus both endpoints.
  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = 1 + Math.floor(bucket * (readings.length - 2) / buckets);
    const end = 1 + Math.floor((bucket + 1) * (readings.length - 2) / buckets);
    for (const axis of recognitionAxes) {
      let min = start, max = start;
      for (let index = start + 1; index < end; index++) {
        if (readings[index]![axis] < readings[min]![axis]) min = index;
        if (readings[index]![axis] > readings[max]![axis]) max = index;
      }
      indices.add(min); indices.add(max);
    }
  }
  return [...indices].sort((a, b) => a - b).map(index => readings[index]!);
}
export function calibrationReadingsJson(readings: CalibrationReadings) {
  return JSON.stringify({ formatVersion: 1, gesture: readings.gesture, source: readings.source, sessionId: readings.sessionId, profileRevision: readings.profileRevision, preparationMs: readings.preparationMs, recognitionAxes: readings.recognitionAxes,
    units: { raw: 'g including gravity', rawTime: 'milliseconds from first sensor frame', template: 'normalized unitless values', templatePosition: 'uniform sample index' }, takes: readings.takes }, null, 2);
}
export function draftReadingsGestures(status: Pick<GestureCalibrationStatus, 'gestures' | 'repetitions' | 'accepted'>): GestureId[] {
  if (!Number.isFinite(status.repetitions) || status.repetitions <= 0) return [];
  return status.gestures.filter((_, index) => status.accepted > index * status.repetitions);
}
export function calibrationTakeSummary(take: CalibrationTakeReadings): { durationMs: number | null; durationKind: 'movement' | 'capture'; largestSpan: number; unit: 'g' | 'normalized' } | null {
  const series = calibrationSeries(take, 'raw') ?? calibrationSeries(take, 'template');
  if (!series) return null;
  return { durationMs: take.template?.durationMs ?? series.elapsedMs, durationKind: take.template ? 'movement' : 'capture', largestSpan: Math.max(...recognitionAxes.map(axis => series.ranges[axis].max - series.ranges[axis].min)), unit: series.unit };
}
export type ReadCalibrationReadings = (gesture: GestureId, sessionId: string | null) => Promise<CalibrationReadings>;
export class CalibrationReadingsRequest {
  snapshot: { loading: boolean; data: CalibrationReadings | null; error: string } = { loading: false, data: null, error: '' };
  private generation = 0;
  constructor(private read: ReadCalibrationReadings | undefined, private changed: () => void) {}
  async load(gesture: GestureId, sessionId: string | null, profileRevision: number) {
    const generation = ++this.generation;
    this.snapshot = { loading: !!this.read, data: null, error: this.read ? '' : 'Update the Android app to view calibration readings.' }; this.changed();
    if (!this.read) return;
    try {
      const data = await this.read(gesture, sessionId);
      if (generation !== this.generation) return;
      if (data.gesture !== gesture || data.source !== (sessionId === null ? 'saved' : 'draft') || data.sessionId !== sessionId || data.profileRevision !== profileRevision) throw Error('These readings changed. Go back and reopen the viewer.');
      if (data.recognitionAxes !== undefined && (!Array.isArray(data.recognitionAxes) || data.recognitionAxes.length !== 2 || data.recognitionAxes[0] !== 'x' || data.recognitionAxes[1] !== 'y')) throw Error('Recognition axes could not be read. Update the Android app and try again.');
      if (!Array.isArray(data.takes) || !Number.isFinite(data.preparationMs) || data.preparationMs < 0 || data.takes.some(take => !Number.isInteger(take.take) || take.take < 1 || (take.raw !== null && (!Array.isArray(take.raw) || (take.raw.length > 0 && !calibrationSeries(take, 'raw')))) || (take.template !== null && (!Array.isArray(take.template.points) || !calibrationSeries(take, 'template'))))) throw Error('Some readings could not be displayed. Try reading them again.');
      if (new Set(data.takes.map(take => take.take)).size !== data.takes.length) throw Error('Take numbers could not be read. Try again.');
      if (data.takes.some(({ template }) => template && (!Number.isFinite(template.durationMs) || template.durationMs < 0 || !Number.isFinite(template.amplitudeG) || template.amplitudeG < 0 || !Number.isInteger(template.modelVersion) || template.modelVersion < 1 || !Number.isFinite(template.maxDistance) || template.maxDistance < 0))) throw Error('Matching-shape metadata could not be read. Try again.');
      if (data.takes.some(({ template }) => template && ((template.storedModelVersion !== undefined && template.storedModelVersion !== null && (!Number.isInteger(template.storedModelVersion) || template.storedModelVersion < 1)) || (template.source !== undefined && !['stored', 'raw_rebuilt', 'projected', 'draft'].includes(template.source)) || (data.recognitionAxes && template.points.some(point => point.z !== 0))))) throw Error('Effective matching-shape metadata could not be read. Try again.');
      this.snapshot = { loading: false, data, error: '' }; this.changed();
    } catch (error) {
      if (generation !== this.generation) return;
      this.snapshot = { loading: false, data: null, error: error instanceof Error ? error.message : 'Could not read calibration data. Try again.' }; this.changed();
    }
  }
  cancel() { ++this.generation; this.snapshot = { loading: false, data: null, error: '' }; }
}
