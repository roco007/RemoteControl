import { isValidElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ Pressable: 'Pressable', Switch: 'Switch', Text: 'Text', View: 'View', StyleSheet: { create: (styles: unknown) => styles }, Platform: { select: (values: { default: string }) => values.default } }));
import { ShakeActionPanel } from './ShakeActionPanel';
import { defaultGestureMappings, defaultGestureOrders, gestureNames, type GestureKey } from '../services/gestureSettings';

type Node = ReactElement<Record<string, any>>;
function find(root: unknown, predicate: (element: Node) => boolean): Node | undefined {
  if (Array.isArray(root)) return root.map(child => find(child, predicate)).find(Boolean);
  if (!isValidElement(root)) return undefined;
  const element = root as Node;
  return predicate(element) ? element : find(element.props.children, predicate);
}
function panel(enabled: boolean, mode: 'directional' | 'count', busy = false, activeGesture: GestureKey | null = null) {
  const onRun = vi.fn(), onConfigure = vi.fn();
  const tree = ShakeActionPanel({ enabled, busy, activeGesture, onRun, onConfigure, onToggle: vi.fn(), onCalibrate: vi.fn(),
    calibrationSummary: '', calibrated: true, status: '', listening: enabled, count: 0, lastCount: 0, lastGesture: '',
    mode, mappings: defaultGestureMappings, orders: defaultGestureOrders, compact: false, dense: false });
  return { onRun, onConfigure, execution: find(tree, node => node.props.testID === 'gesture-execution-name'),
    normal: find(tree, node => node.props.testID === 'shake-actions-normal'),
    card: (gesture: GestureKey) => find(tree, node => node.props.accessibilityLabel?.includes(`${gestureNames[gesture]}:`))!,
    configure: find(tree, node => node.props.accessibilityLabel === 'Configure gestures')! };
}

describe('gesture card presses', () => {
  for (const mode of ['directional', 'count'] as const) {
    for (const gesture of defaultGestureOrders[mode]) {
      it(`runs ${gesture} without opening settings when enabled`, () => {
        const view = panel(true, mode), card = view.card(gesture);
        expect(card).toBeDefined();
        expect(card.props.accessibilityLabel).toContain(`Run ${gestureNames[gesture]}`);
        card.props.onPress();
        expect(view.onRun).toHaveBeenCalledExactlyOnceWith(gesture);
        expect(view.onConfigure).not.toHaveBeenCalled();
      });
      it(`opens the ${gesture} editor without running actions when disabled`, () => {
        const view = panel(false, mode), card = view.card(gesture);
        expect(card).toBeDefined();
        card.props.onPress();
        expect(view.onConfigure).toHaveBeenCalledExactlyOnceWith(gesture);
        expect(view.onRun).not.toHaveBeenCalled();
      });
    }
  }
  it('keeps Configure available while enabled and busy; disabled gestures remain editable', () => {
    const enabled = panel(true, 'directional', true);
    expect(enabled.card('left').props.disabled).toBe(true);
    enabled.configure.props.onPress();
    expect(enabled.onConfigure).toHaveBeenCalledExactlyOnceWith();
    expect(enabled.onRun).not.toHaveBeenCalled();
    const disabled = panel(false, 'directional', true);
    expect(disabled.card('left').props.disabled).toBe(false);
    disabled.card('left').props.onPress();
    expect(disabled.onConfigure).toHaveBeenCalledExactlyOnceWith('left');
  });
});

describe('gesture execution display', () => {
  for (const gesture of ['left', 'right', 'left_straight', 'right_straight'] as const) {
    it(`fills the panel with ${gestureNames[gesture]} and hides its normal controls during execution`, () => {
      const running = panel(true, 'directional', true, gesture);
      expect(running.execution?.props.children).toBe(gestureNames[gesture]);
      expect(running.normal?.props.pointerEvents).toBe('none');
      expect(running.normal?.props.accessibilityElementsHidden).toBe(true);
      expect(running.normal?.props.importantForAccessibility).toBe('no-hide-descendants');
      expect(running.onRun).not.toHaveBeenCalled();
      const finished = panel(true, 'directional');
      expect(finished.execution).toBeUndefined();
      expect(finished.normal?.props.pointerEvents).toBe('auto');
      expect(finished.normal?.props.accessibilityElementsHidden).toBe(false);
    });
  }
  it('keeps the normal display for count gestures, rejected taps, and uncertain completion', () => {
    for (const gesture of ['single', 'double', 'triple', null] as const) {
      const view = panel(true, gesture ? 'count' : 'directional', true, gesture);
      expect(view.execution).toBeUndefined();
      expect(view.normal?.props.pointerEvents).toBe('auto');
    }
  });
});
