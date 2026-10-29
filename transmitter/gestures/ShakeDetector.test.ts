import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShakeDetector } from './ShakeDetector';

describe('shake sequences', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  function setup() {
    const actions: number[] = [];
    const progress: number[] = [];
    const detector = new ShakeDetector(count => actions.push(count), count => progress.push(count));
    const sample = (x: number, y = 0, z = 1) => detector.addSample({ x, y, z });
    const rest = () => {
      sample(0);
      vi.advanceTimersByTime(50); sample(0);
      vi.advanceTimersByTime(50); sample(0);
    };
    const shake = () => {
      sample(2.5);
      vi.advanceTimersByTime(50); rest();
    };
    return { detector, actions, progress, sample, rest, shake };
  }

  it('ignores gravity, orientation changes, and everyday low acceleration', () => {
    const h = setup();
    for (const sample of [{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0.5, y: 0.4, z: 1.2 }]) {
      h.detector.addSample(sample); vi.advanceTimersByTime(300);
    }
    vi.advanceTimersByTime(1000);
    expect(h.actions).toEqual([]);
    expect(h.progress).toEqual([]);
  });

  it('ignores pure depth motion while the upright phone X/Y stays still', () => {
    const h = setup();
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const z of [0, 6, 0, -6]) {
        h.detector.addSample({ x: 0, y: 1, z }); vi.advanceTimersByTime(40);
      }
    }
    h.detector.addSample({ x: 0, y: 1, z: 0 }); vi.advanceTimersByTime(1500);
    expect(h.actions).toEqual([]); expect(h.progress).toEqual([]);
  });

  it('keeps sequence counts, progress, and completion time identical when only Z changes', () => {
    const events = [[], []] as { count: number; at: number }[][];
    const progress = [[], []] as { count: number; at: number }[][];
    const detectors = [0, 1].map(index => new ShakeDetector(count => events[index]!.push({ count, at: Date.now() }), count => progress[index]!.push({ count, at: Date.now() })));
    const motion = [0, 3, 0, -3, 0, 3, 0, -3, ...Array<number>(50).fill(0)];
    motion.forEach((x, index) => {
      detectors[0]!.addSample({ x, y: 1, z: 0 });
      detectors[1]!.addSample({ x, y: 1, z: index % 2 ? -12 : 9 });
      vi.advanceTimersByTime(40);
    });
    expect(events[0]!.map(event => event.count)).toEqual([2]);
    expect(events[1]).toEqual(events[0]);
    expect(progress[1]).toEqual(progress[0]);
    detectors.forEach(detector => detector.dispose());
  });

  it('cannot turn sub-threshold X/Y motion into a trigger by increasing Z', () => {
    const h = setup();
    for (const z of [1, 8, -8, 4, 0, -4]) {
      h.detector.addSample({ x: 0.4, y: 1, z }); vi.advanceTimersByTime(250);
    }
    vi.advanceTimersByTime(1500); expect(h.actions).toEqual([]);
  });

  it('waits for the sequence window before dispatching a single shake', () => {
    const h = setup(); h.shake();
    expect(h.progress).toEqual([1]);
    vi.advanceTimersByTime(949);
    expect(h.actions).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.actions).toEqual([1]);
    expect(h.progress).toEqual([1, 0]);
  });

  it('dispatches only double shake after two separate shake bursts', () => {
    const h = setup(); h.shake(); vi.advanceTimersByTime(200); h.shake();
    vi.advanceTimersByTime(949);
    expect(h.actions).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.actions).toEqual([2]);
    expect(h.progress).toEqual([1, 2, 0]);
  });

  it('dispatches only triple shake without first dispatching single or double', () => {
    const h = setup();
    h.shake(); vi.advanceTimersByTime(200); h.shake(); vi.advanceTimersByTime(200); h.shake();
    expect(h.actions).toEqual([3]);
    vi.advanceTimersByTime(2000);
    expect(h.actions).toEqual([3]);
    expect(h.progress).toEqual([1, 2, 3, 0]);
  });

  it('treats sustained high acceleration and its brief rebound as one shake', () => {
    const h = setup(); h.sample(2.5);
    for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(50); h.sample(-2.6); }
    vi.advanceTimersByTime(50); h.sample(0);
    vi.advanceTimersByTime(50); h.sample(2.8);
    vi.advanceTimersByTime(1100);
    expect(h.actions).toEqual([1]);
    expect(h.progress).toEqual([1, 0]);
  });

  it('rejects a quick rebound even after passing through a quiet valley', () => {
    const h = setup(); h.shake();
    vi.advanceTimersByTime(50); h.sample(2.5);
    vi.advanceTimersByTime(1100);
    expect(h.actions).toEqual([1]);
  });

  it('cancels a pending destructive sequence when reset', () => {
    const h = setup(); h.shake(); vi.advanceTimersByTime(200); h.shake();
    h.detector.reset(); vi.advanceTimersByTime(2000);
    expect(h.actions).toEqual([]);
    expect(h.progress.at(-1)).toBe(0);
    h.shake(); vi.advanceTimersByTime(1100);
    expect(h.actions).toEqual([1]);
  });

  it('does not dispatch queued or future samples after dispose', () => {
    const h = setup(); h.shake(); h.detector.dispose();
    vi.advanceTimersByTime(1500); h.shake(); vi.advanceTimersByTime(1000);
    expect(h.actions).toEqual([]);
  });

  it('ignores further shaking during cooldown, then accepts a fresh sequence', () => {
    const h = setup(); h.shake(); vi.advanceTimersByTime(950);
    expect(h.actions).toEqual([1]);
    h.shake(); vi.advanceTimersByTime(200); h.shake();
    vi.advanceTimersByTime(500);
    expect(h.actions).toEqual([1]);
    h.rest(); h.shake(); vi.advanceTimersByTime(1100);
    expect(h.actions).toEqual([1, 1]);
  });

  it('rejects invalid and backwards-timestamped samples without extending a sequence', () => {
    const h = setup(); h.detector.addSample({ x: 2.5, y: 0, z: 1 }, 100);
    h.detector.addSample({ x: Number.NaN, y: 0, z: 1 }, 101);
    h.detector.addSample({ x: Number.POSITIVE_INFINITY, y: 0, z: 1 }, 102);
    h.detector.addSample({ x: 2.5, y: 0, z: 1 }, Number.NaN);
    h.detector.addSample({ x: 0, y: 0, z: 1 }, 50);
    h.detector.addSample({ x: 2.5, y: 0, z: 1 }, 60);
    vi.advanceTimersByTime(1100);
    expect(h.actions).toEqual([1]);
  });

  // 25 Hz traces: each back-and-forth cycle has two opposing peaks and only a
  // single 40 ms sample near gravity at each reversal, with no sustained rest.
  function oscillate(sample: (x: number) => void, cycles: number) {
    for (let cycle = 0; cycle < cycles; cycle++) {
      for (const x of [2.5, 1.7, 0.6, 1.7, -2.5, -1.7, -0.6, -1.7]) {
        sample(x); vi.advanceTimersByTime(40);
      }
    }
    sample(0);
  }

  it('counts a quick back-and-forth oscillation as one shake rather than two peaks', () => {
    const h = setup(); oscillate(h.sample, 1);
    expect(h.actions).toEqual([]);
    vi.advanceTimersByTime(1100);
    expect(h.actions).toEqual([1]);
    expect(h.progress).toEqual([1, 0]);
  });

  it('counts two continuous shake cycles despite only 40 ms valleys', () => {
    const h = setup(); oscillate(h.sample, 2);
    expect(h.actions).toEqual([]);
    expect(h.progress).toEqual([1, 2]);
    vi.advanceTimersByTime(1100);
    expect(h.actions).toEqual([2]);
  });

  it('counts three continuous cycles without taking an early screenshot', () => {
    const h = setup(); oscillate(h.sample, 3);
    vi.advanceTimersByTime(1100);
    expect(h.actions).toEqual([3]);
    expect(h.progress).toEqual([1, 2, 3, 0]);
  });

  it('counts successive cycles with 80 ms valleys without requiring a full rest', () => {
    const h = setup();
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const x of [2.5, 1.7, 0.6, 0.6, 1.7, -2.5, -1.7, -0.6, -0.6, -1.7]) {
        h.sample(x); vi.advanceTimersByTime(40);
      }
    }
    expect(h.progress).toEqual([1, 2]);
    h.sample(0); vi.advanceTimersByTime(1100);
    expect(h.actions).toEqual([2]);
  });

  it('keeps counting rapid continuous shaking with opposing peaks 80 ms apart', () => {
    const h = setup();
    for (let cycle = 0; cycle < 6; cycle++) {
      for (const x of [0, 3, 0, -3]) { h.sample(x); vi.advanceTimersByTime(40); }
    }
    h.sample(0); vi.advanceTimersByTime(1100);
    expect(h.actions).toEqual([3]);
    expect(h.progress).toEqual([1, 2, 3, 0]);
  });

  it('keeps counting broad repeated peaks separated by brief valleys', () => {
    const h = setup();
    for (let cycle = 0; cycle < 5; cycle++) {
      for (const x of [0, 3, 3, 0, -3, -3]) { h.sample(x); vi.advanceTimersByTime(40); }
    }
    h.sample(0); vi.advanceTimersByTime(1100);
    expect(h.actions).toEqual([3]);
    expect(h.progress).toEqual([1, 2, 3, 0]);
  });

  it('waits until movement stops even when sustained acceleration is only one shake', () => {
    const h = setup();
    for (let i = 0; i < 30; i++) { h.sample(2.5); vi.advanceTimersByTime(40); }
    expect(h.actions).toEqual([]);
    expect(h.progress).toEqual([1]);
    h.sample(0); vi.advanceTimersByTime(1100);
    expect(h.actions).toEqual([1]);
  });

  it('keeps slower successive shakes together for a full human-paced sequence', () => {
    const h = setup(); h.shake(); vi.advanceTimersByTime(750);
    expect(h.actions).toEqual([]);
    h.shake(); vi.advanceTimersByTime(1100);
    expect(h.actions).toEqual([2]);
  });

  it('does not resolve while weaker motion continues between qualifying shakes', () => {
    const h = setup(); h.shake();
    for (let i = 0; i < 30; i++) { h.sample(1.7); vi.advanceTimersByTime(40); }
    expect(h.actions).toEqual([]);
    // A separate one-way jerk requires a real calm gap; the weaker motion above
    // must still keep the pending first action from firing before that gap.
    h.sample(0); vi.advanceTimersByTime(240); h.shake();
    vi.advanceTimersByTime(1100);
    expect(h.actions).toEqual([2]);
  });

  it.each([40, 80, 160].flatMap(interval => [1, 2, 3].map(cycles => ({ interval, cycles }))))(
    'recognizes exactly $cycles full cycles at a $interval ms sample interval', ({ interval, cycles }) => {
      const h = setup();
      for (let cycle = 0; cycle < cycles; cycle++) {
        for (const x of [0, 3, 0, -3]) { h.sample(x); vi.advanceTimersByTime(interval); }
      }
      h.sample(0); vi.advanceTimersByTime(1100);
      expect(h.actions).toEqual([cycles]);
      expect(h.progress).toEqual([...Array.from({ length: cycles }, (_, i) => i + 1), 0]);
    });

  it.each([1, 2, 3])('recognizes exactly %i cycles with broad acceleration peaks', cycles => {
    const h = setup();
    for (let cycle = 0; cycle < cycles; cycle++) {
      for (const x of [0, 3, 3, 0, -3, -3]) { h.sample(x); vi.advanceTimersByTime(40); }
    }
    h.sample(0); vi.advanceTimersByTime(1100);
    expect(h.actions).toEqual([cycles]);
  });

  it.each(['x', 'y'] as const)('pairs opposing motion along the %s axis', axis => {
    const h = setup();
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const delta of [0, -3, 0, 3]) {
        const sample = { x: 0, y: 0, z: 1 }; sample[axis] += delta;
        h.detector.addSample(sample, 1_000_000 + Date.now()); vi.advanceTimersByTime(40);
      }
    }
    h.detector.addSample({ x: 0, y: 0, z: 1 }, 1_000_000 + Date.now());
    vi.advanceTimersByTime(1100);
    expect(h.actions).toEqual([2]);
  });

  it('can begin shaking before a calm gravity baseline has been sampled', () => {
    const h = setup();
    for (const x of [3, 0, -3, 0, 3, 0, -3]) { h.sample(x); vi.advanceTimersByTime(40); }
    h.sample(0); vi.advanceTimersByTime(1100);
    expect(h.actions).toEqual([2]);
  });

  it.each([1, 2, 3])('recognizes %i upright Y cycles when gravity cancels the return magnitude', cycles => {
    const h = setup();
    for (let cycle = 0; cycle < cycles; cycle++) {
      for (const y of [1, 3, 1, -1]) {
        h.detector.addSample({ x: 0, y, z: 0 }); vi.advanceTimersByTime(40);
      }
    }
    h.detector.addSample({ x: 0, y: 1, z: 0 }); vi.advanceTimersByTime(1100);
    expect(h.actions).toEqual([cycles]);
  });

  it.each([700, 900, 1000].flatMap(spacing => [1, 2, 3].map(cycles => ({ spacing, cycles }))))(
    'recognizes $cycles separate shake bursts spaced $spacing ms apart', ({ spacing, cycles }) => {
      const h = setup();
      for (let cycle = 0; cycle < cycles; cycle++) {
        oscillate(h.sample, 1);
        if (cycle < cycles - 1) {
          vi.advanceTimersByTime(spacing - 320);
          expect(h.actions).toEqual([]);
        }
      }
      vi.advanceTimersByTime(1100);
      expect(h.actions).toEqual([cycles]);
    });

  it.each([1, 2, 3])('preserves raw trigger sensitivity for %i upright Y shakes with short pauses', cycles => {
    const h = setup();
    for (let cycle = 0; cycle < cycles; cycle++) {
      for (const y of [1, 2.5, 1, -0.5]) {
        h.detector.addSample({ x: 0, y, z: 0 }); vi.advanceTimersByTime(80);
      }
      h.detector.addSample({ x: 0, y: 1, z: 0 });
      if (cycle < cycles - 1) { vi.advanceTimersByTime(580); expect(h.actions).toEqual([]); }
    }
    vi.advanceTimersByTime(1100);
    expect(h.actions).toEqual([cycles]);
  });
});
