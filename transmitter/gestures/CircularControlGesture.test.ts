import { describe, expect, it } from 'vitest';
import { CircularControlGesture } from './CircularControlGesture';

const center = { x: 170, y: 240 };
const deadZoneRadius = 40;

function point(degrees: number, radius = 120) {
  const radians = degrees * Math.PI / 180;
  return { x: center.x + Math.cos(radians) * radius, y: center.y + Math.sin(radians) * radius };
}

function trace(gesture: CircularControlGesture, degrees: number[]) {
  return degrees.reduce((total, angle) => total + gesture.move(point(angle)), 0);
}

describe('circular sound and light gesture', () => {
  it.each([
    ['clockwise quarter turn', [45, 90], 16],
    ['clockwise half turn', [45, 90, 135, 180], 32],
    ['clockwise full turn', [45, 90, 135, 180, 225, 270, 315, 360], 64],
    ['anticlockwise quarter turn', [-45, -90], -16],
    ['anticlockwise half turn', [-45, -90, -135, -180], -32],
    ['anticlockwise full turn', [-45, -90, -135, -180, -225, -270, -315, -360], -64],
  ])('counts a %s proportionally', (_name, angles, expected) => {
    const gesture = new CircularControlGesture();
    gesture.begin(point(0), center, deadZoneRadius);
    expect(trace(gesture, angles)).toBe(expected);
  });

  it('accepts a sampled quarter turn without requiring intermediate events', () => {
    const gesture = new CircularControlGesture();
    gesture.begin(point(0), center, deadZoneRadius);
    expect(gesture.move(point(90))).toBe(16);
    expect(gesture.move(point(0))).toBe(-16);
  });

  it.each([
    [174.375, -174.375, 2],
    [-174.375, 174.375, -2],
  ])('unwraps crossing from %s to %s degrees', (start, end, expected) => {
    const gesture = new CircularControlGesture();
    gesture.begin(point(start), center, deadZoneRadius);
    expect(gesture.move(point(end))).toBe(expected);
  });

  it.each([1, -1])('accumulates sub-step movement in direction %s and returns only new whole steps', direction => {
    const gesture = new CircularControlGesture();
    gesture.begin(point(0), center, deadZoneRadius);
    expect(gesture.move(point(2 * direction))).toBe(0);
    expect(gesture.move(point(4 * direction))).toBe(0);
    expect(gesture.move(point(6 * direction))).toBe(direction);
    expect(gesture.move(point(11.25 * direction))).toBe(direction);
    expect(gesture.move(point(11.25 * direction))).toBe(0);
  });

  it('cancels small back-and-forth jitter rather than counting travelled distance', () => {
    const gesture = new CircularControlGesture();
    gesture.begin(point(0), center, deadZoneRadius);
    for (let repeat = 0; repeat < 20; repeat++) {
      for (const angle of [2, -2, 3, -3, 0]) expect(gesture.move(point(angle))).toBe(0);
    }
    expect(gesture.move(point(5.625))).toBe(1);
  });

  it('changes direction during one continuous stroke', () => {
    const gesture = new CircularControlGesture();
    gesture.begin(point(0), center, deadZoneRadius);
    expect(trace(gesture, [45, 90])).toBe(16);
    expect(trace(gesture, [45, 0, -45, -90])).toBe(-32);
  });

  it('keeps counting multiple revolutions', () => {
    const gesture = new CircularControlGesture();
    gesture.begin(point(0), center, deadZoneRadius);
    const angles = Array.from({ length: 48 }, (_, index) => (index + 1) * 22.5);
    expect(trace(gesture, angles)).toBe(192);
    expect(trace(gesture, [...angles].reverse().slice(1).concat(0))).toBe(-192);
  });

  it('does not change sensitivity when the finger changes distance from the center', () => {
    const gesture = new CircularControlGesture();
    gesture.begin(point(0, 65), center, deadZoneRadius);
    expect(gesture.move(point(0, 240))).toBe(0);
    expect(gesture.move(point(45, 65))).toBe(8);
    expect(gesture.move(point(90, 240))).toBe(8);
  });

  it('discards center crossings and anchors at the first point outside again', () => {
    const gesture = new CircularControlGesture();
    gesture.begin(point(0), center, deadZoneRadius);
    expect(gesture.move(point(4))).toBe(0);
    expect(gesture.move(point(90, 20))).toBe(0);
    expect(gesture.move(center)).toBe(0);
    expect(gesture.move(point(180))).toBe(0);
    expect(gesture.move(point(182))).toBe(0);
    expect(gesture.move(point(185.625))).toBe(1);
  });

  it('can begin inside the deadzone and anchors only after leaving it', () => {
    const gesture = new CircularControlGesture();
    gesture.begin(center, center, deadZoneRadius);
    expect(gesture.move(point(0, deadZoneRadius))).toBe(0);
    expect(gesture.move(point(90))).toBe(0);
    expect(gesture.move(point(135))).toBe(8);
  });

  it('discards implausible jumps and resumes from the new point without stored fractions', () => {
    const gesture = new CircularControlGesture();
    gesture.begin(point(0), center, deadZoneRadius);
    expect(gesture.move(point(4))).toBe(0);
    expect(gesture.move(point(160))).toBe(0);
    expect(gesture.move(point(162))).toBe(0);
    expect(gesture.move(point(165.625))).toBe(1);
  });

  it('begins a fresh stroke at any position without a jump or a previous fraction', () => {
    const gesture = new CircularControlGesture();
    gesture.begin(point(0), center, deadZoneRadius);
    expect(gesture.move(point(4))).toBe(0);
    gesture.begin(point(135), center, deadZoneRadius);
    expect(gesture.move(point(137))).toBe(0);
    expect(gesture.move(point(140.625))).toBe(1);
  });

  it('emits nothing before begin or after reset', () => {
    const gesture = new CircularControlGesture();
    expect(trace(gesture, [0, 45, 90])).toBe(0);
    gesture.begin(point(0), center, deadZoneRadius);
    expect(gesture.move(point(4))).toBe(0);
    gesture.reset();
    expect(trace(gesture, [45, 90, 135])).toBe(0);
    gesture.begin(point(180), center, deadZoneRadius);
    expect(gesture.move(point(182))).toBe(0);
    expect(gesture.move(point(185.625))).toBe(1);
  });

  it.each([
    { x: Number.NaN, y: 240 },
    { x: 170, y: Number.POSITIVE_INFINITY },
    { x: Number.NEGATIVE_INFINITY, y: 240 },
  ])('discards invalid points and safely reanchors afterwards: %o', invalidPoint => {
    const gesture = new CircularControlGesture();
    gesture.begin(point(0), center, deadZoneRadius);
    expect(gesture.move(point(4))).toBe(0);
    expect(gesture.move(invalidPoint)).toBe(0);
    expect(gesture.move(point(90))).toBe(0);
    expect(gesture.move(point(92))).toBe(0);
    expect(gesture.move(point(95.625))).toBe(1);
  });

  it.each([
    [point(0), { x: Number.NaN, y: 0 }, 40],
    [point(0), { x: 0, y: Number.POSITIVE_INFINITY }, 40],
    [point(0), center, Number.NaN],
    [point(0), center, Number.POSITIVE_INFINITY],
    [point(0), center, -1],
    [{ x: Number.NaN, y: 0 }, center, 40],
  ])('leaves invalid stroke geometry inactive: %o %o %s', (start, origin, radius) => {
    const gesture = new CircularControlGesture();
    gesture.begin(point(0), center, deadZoneRadius);
    gesture.begin(start, origin, radius);
    expect(trace(gesture, [0, 45, 90])).toBe(0);
  });

  it('treats an overflowing distance as invalid geometry', () => {
    const gesture = new CircularControlGesture();
    gesture.begin({ x: -Number.MAX_VALUE, y: 0 }, { x: Number.MAX_VALUE, y: 0 }, 0);
    expect(gesture.move({ x: Number.MAX_VALUE, y: 100 })).toBe(0);
    expect(gesture.move({ x: Number.MAX_VALUE - 1e300, y: 100 })).toBe(0);
  });
});
