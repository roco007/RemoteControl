import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PanResponder, Platform, StyleSheet, View, type LayoutRectangle, type ViewProps, type ViewStyle } from 'react-native';
import { gestureNames, type GestureKey } from '../services/gestureSettings';
import { theme as t } from './theme';

const ROW_GAP = 12;
type RowLayout = { gesture: GestureKey; y: number; height: number };
type Drag = { gesture: GestureKey; from: number; to: number; dy: number; order: string; rows: RowLayout[] };
type Props = {
  gestures: readonly GestureKey[];
  enabled: boolean;
  onMove: (gesture: GestureKey, targetIndex: number) => void;
  onDraggingChange: (dragging: boolean) => void;
  renderItem: (gesture: GestureKey, index: number, handle: ReactNode) => ReactNode;
};

/** Only the grip captures a responder, leaving each card's action picker usable. */
export function ReorderableGestureList({ gestures, enabled, onMove, onDraggingChange, renderItem }: Props) {
  const order = gestures.join('|');
  const callbacks = useRef({ gestures, enabled, onMove, onDraggingChange, order });
  callbacks.current = { gestures, enabled, onMove, onDraggingChange, order };
  const layouts = useRef(new Map<GestureKey, LayoutRectangle>());
  const active = useRef<Drag | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  const finish = useCallback((commit: boolean) => {
    const current = active.current;
    if (!current) return;
    active.current = null;
    setDrag(null);
    callbacks.current.onDraggingChange(false);
    if (commit && callbacks.current.enabled && current.order === callbacks.current.order && current.to !== current.from) {
      callbacks.current.onMove(current.gesture, current.to);
    }
  }, []);

  useEffect(() => { finish(false); }, [enabled, order, finish]);
  useEffect(() => () => {
    if (active.current) callbacks.current.onDraggingChange(false);
    active.current = null;
  }, []);

  const canStart = () => callbacks.current.enabled && !active.current && callbacks.current.gestures.every(gesture => (layouts.current.get(gesture)?.height ?? 0) > 0);
  const start = (gesture: GestureKey) => {
    if (!canStart()) return;
    let y = 0;
    // Web onLayout can retain an old y after a reorder. Measured heights plus
    // the list's fixed gap give current positions relative to this list.
    const rows = callbacks.current.gestures.map(key => {
      const height = layouts.current.get(key)!.height;
      const row = { gesture: key, y, height };
      y += height + ROW_GAP;
      return row;
    });
    const from = rows.findIndex(row => row.gesture === gesture);
    if (from < 0) return;
    const next: Drag = { gesture, from, to: from, dy: 0, order: callbacks.current.order, rows };
    active.current = next;
    setDrag(next);
    callbacks.current.onDraggingChange(true);
  };

  const move = (distance: number) => {
    const current = active.current;
    if (!current) return;
    const source = current.rows[current.from]!;
    const last = current.rows[current.rows.length - 1]!;
    const top = Math.max(0, Math.min(last.y + last.height - source.height, source.y + distance));
    const remaining = current.rows.filter(row => row.gesture !== current.gesture);
    let slotTop = 0;
    let target = 0;
    let nearest = Infinity;
    // Compare insertion slots, rather than row centres: an expanded action
    // picker can be much taller than the cards it moves past.
    for (let index = 0; index <= remaining.length; index++) {
      const delta = Math.abs(top - slotTop);
      if (delta < nearest) { nearest = delta; target = index; }
      if (remaining[index]) slotTop += remaining[index]!.height + ROW_GAP;
    }
    const next = { ...current, dy: top - source.y, to: target };
    active.current = next;
    setDrag(next);
  };

  const preview = drag ? [...drag.rows] : [];
  if (drag) preview.splice(drag.to, 0, preview.splice(drag.from, 1)[0]!);
  const positions = new Map<GestureKey, number>();
  let previewY = 0;
  for (const row of preview) { positions.set(row.gesture, previewY); previewY += row.height + ROW_GAP; }

  return <View style={s.list}>
    {gestures.map((gesture, index) => {
      const dragging = drag?.gesture === gesture;
      const original = drag?.rows.find(row => row.gesture === gesture);
      const translateY = dragging ? drag.dy : original ? (positions.get(gesture) ?? original.y) - original.y : 0;
      const position = drag ? preview.findIndex(row => row.gesture === gesture) : index;
      return <View key={gesture} testID={`gesture-order-row-${gesture}`} onLayout={event => {
        const next = event.nativeEvent.layout;
        const previous = layouts.current.get(gesture);
        layouts.current.set(gesture, next);
        if (active.current && previous && Math.abs(previous.height - next.height) > 1) finish(false);
      }} pointerEvents={drag && !dragging ? 'none' : 'auto'} style={[s.row, { transform: [{ translateY }], zIndex: dragging ? 2 : 0 }, dragging && s.dragging]}>
        {renderItem(gesture, position, <ReorderGrip gesture={gesture} index={index} count={gestures.length} enabled={enabled} dragging={dragging} canStart={canStart} onStart={() => start(gesture)} onDrag={move} onFinish={() => finish(true)} onCancel={() => finish(false)} onStep={direction => {
          if (!active.current && callbacks.current.enabled) callbacks.current.onMove(gesture, index + direction);
        }} />)}
      </View>;
    })}
  </View>;
}

type GripProps = {
  gesture: GestureKey;
  index: number;
  count: number;
  enabled: boolean;
  dragging: boolean;
  canStart: () => boolean;
  onStart: () => void;
  onDrag: (distance: number) => void;
  onFinish: () => void;
  onCancel: () => void;
  onStep: (direction: -1 | 1) => void;
};

function ReorderGrip(props: GripProps) {
  const latest = useRef(props);
  latest.current = props;
  const [focused, setFocused] = useState(false);
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => latest.current.canStart(),
    onMoveShouldSetPanResponder: () => latest.current.canStart(),
    onPanResponderGrant: event => { event.preventDefault(); latest.current.onStart(); },
    onPanResponderMove: (_event, state) => {
      if (state.numberActiveTouches > 1) latest.current.onCancel();
      else latest.current.onDrag(state.dy);
    },
    onPanResponderRelease: () => latest.current.onFinish(),
    onPanResponderTerminate: () => latest.current.onCancel(),
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
  }), []);
  const step = (direction: -1 | 1) => {
    const current = latest.current;
    if (current.enabled && !current.dragging && current.index + direction >= 0 && current.index + direction < current.count) current.onStep(direction);
  };
  const onKeyDown: ViewProps['onKeyDown'] = event => {
    const key = event.nativeEvent.key;
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      event.preventDefault(); event.stopPropagation();
      step(key === 'ArrowUp' ? -1 : 1);
    } else if (key === 'Escape' && latest.current.dragging) {
      event.preventDefault(); event.stopPropagation(); latest.current.onCancel();
    }
  };
  return <View {...responder.panHandlers} accessible accessibilityRole={Platform.OS === 'web' ? 'button' : 'adjustable'} accessibilityLabel={`Reorder ${gestureNames[props.gesture]}`} accessibilityHint={Platform.OS === 'web' ? 'Drag to move, or use the Up and Down arrow keys.' : 'Drag to move, or adjust to move earlier or later.'} accessibilityValue={{ min: 1, max: props.count, now: props.index + 1, text: `Position ${props.index + 1} of ${props.count}` }} accessibilityState={{ disabled: !props.enabled }} accessibilityActions={[...(props.index > 0 ? [{ name: 'decrement', label: 'Move earlier' }] : []), ...(props.index < props.count - 1 ? [{ name: 'increment', label: 'Move later' }] : [])]} onAccessibilityAction={event => {
    if (event.nativeEvent.actionName === 'increment') step(1);
    else if (event.nativeEvent.actionName === 'decrement') step(-1);
  }} tabIndex={props.enabled ? 0 : -1} onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); if (latest.current.dragging) latest.current.onCancel(); }} onKeyDown={Platform.OS === 'web' ? onKeyDown : undefined} style={[s.grip, Platform.OS === 'web' && webGripStyle, (focused || props.dragging) && s.activeGrip]}>
    <View style={s.dots} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{[0, 1].map(column => <View key={column} style={s.dotColumn}>{[0, 1, 2].map(row => <View key={row} style={[s.dot, props.dragging && s.activeDot]} />)}</View>)}</View>
  </View>;
}

const webGripStyle: ViewStyle & { touchAction: 'none'; userSelect: 'none' } = { cursor: 'pointer', touchAction: 'none', userSelect: 'none' };
const s = StyleSheet.create({
  list: { gap: ROW_GAP }, row: { position: 'relative' },
  dragging: { elevation: 6, boxShadow: '0 5px 14px rgba(0, 0, 0, 0.22)' },
  grip: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: t.raised, borderWidth: 1, borderColor: t.border, borderRadius: 10 },
  activeGrip: { borderColor: t.accent, backgroundColor: t.accentDark }, dots: { flexDirection: 'row', gap: 4 }, dotColumn: { gap: 4 }, dot: { width: 3, height: 3, borderRadius: 2, backgroundColor: t.muted }, activeDot: { backgroundColor: t.accent },
});
