import { Gesture } from 'react-native-gesture-handler';
import type { GestureInterpreter } from './GestureInterpreter';

// A held-pan must activate from its native timer only. In RNGH's Android
// recognizer, minDistance(0) would activate immediately, bypassing that timer.
const HOLD_TIMER_ONLY_DISTANCE = 10_000;

function multiFingerSwipe(fingers: 3 | 4, interpreter: GestureInterpreter) {
  let active = false;
  let cancelled = false;
  let committed = false;
  let x = 0;
  let y = 0;
  const reset = () => { active = false; cancelled = false; committed = false; x = y = 0; };
  const commit = () => {
    if (!active || cancelled || committed) return;
    committed = true;
    interpreter.swipe(fingers, x, y);
  };
  return Gesture.Pan().minPointers(fingers).maxPointers(fingers).minDistance(15).averageTouches(true).runOnJS(true)
    .onStart(event => {
      active = event.numberOfPointers === fingers && !cancelled;
      x = event.translationX; y = event.translationY;
      if (active) interpreter.beginSwipe();
    })
    .onUpdate(event => {
      if (event.numberOfPointers > fingers) cancelled = true;
      if (event.numberOfPointers === fingers) { x = event.translationX; y = event.translationY; }
    })
    .onTouchesDown(event => {
      if (event.numberOfTouches === 1) reset();
      else if (event.numberOfTouches > fingers) cancelled = true;
    })
    .onTouchesCancelled(() => { cancelled = true; })
    // Android emits touchesUp before PanGestureHandler fails when remaining
    // pointers drop below minPointers. Commit the last complete-group movement
    // here; a failure/cancel callback alone must never produce navigation.
    .onTouchesUp(event => { if (event.numberOfTouches < fingers) commit(); })
    .onEnd((_event, success) => { if (success) commit(); })
    .onFinalize(reset);
}

/**
 * Each native recognizer owns one gesture. All networking runs on JS, without
 * setState per movement. Pan translations are rebased on activation/count change.
 */
export function createTrackpadGesture(interpreter: GestureInterpreter) {
  let tapPointers = 1;
  let doubleTapPointers = 1;
  let rightTapPointers = 0;
  const singleTap = Gesture.Tap().numberOfTaps(1).maxDuration(230).maxDistance(7).runOnJS(true)
    .onTouchesDown(event => { tapPointers = Math.max(tapPointers, event.numberOfTouches); })
    .onEnd((_event, success) => { if (success && tapPointers === 1) interpreter.tap(); })
    .onFinalize(() => { tapPointers = 1; });
  const doubleTap = Gesture.Tap().numberOfTaps(2).maxDelay(240).maxDuration(230).maxDistance(7).runOnJS(true)
    .onTouchesDown(event => { doubleTapPointers = Math.max(doubleTapPointers, event.numberOfTouches); })
    .onEnd((_event, success) => { if (success && doubleTapPointers === 1) interpreter.doubleTap(); })
    .onFinalize(() => { doubleTapPointers = 1; });
  const rightTap = Gesture.Tap().minPointers(2).numberOfTaps(1).maxDuration(230).maxDistance(7).runOnJS(true)
    .onTouchesDown(event => { rightTapPointers = Math.max(rightTapPointers, event.numberOfTouches); })
    .onEnd((_event, success) => { if (success && rightTapPointers === 2) interpreter.rightTap(); })
    .onFinalize(() => { rightTapPointers = 0; });

  const pointer = Gesture.Pan().minPointers(1).maxPointers(1).minDistance(2).runOnJS(true)
    .onStart(event => interpreter.beginPointer(event.translationX, event.translationY))
    .onUpdate(event => interpreter.pointer(event.translationX, event.translationY, event.numberOfPointers, event.velocityX, event.velocityY))
    .onFinalize(() => interpreter.endDrag());

  // A long-press-activated pan keeps its button down throughout arbitrarily
  // long drags. The ordinary pointer pan is the sole movement source, so the
  // simultaneous recognizers cannot double the cursor deltas.
  const longPress = Gesture.Pan().minPointers(1).maxPointers(1).minDistance(HOLD_TIMER_ONLY_DISTANCE).activateAfterLongPress(320).runOnJS(true)
    .onStart(() => interpreter.beginDrag()).onFinalize(() => interpreter.endDrag());
  const scroll = Gesture.Pan().minPointers(2).maxPointers(2).minDistance(5).averageTouches(true).runOnJS(true)
    .onStart(event => { interpreter.endDrag(); interpreter.beginScroll(event.translationX, event.translationY, event.numberOfPointers); })
    .onUpdate(event => interpreter.scroll(event.translationX, event.translationY, event.numberOfPointers));
  // Native pinch recognizers can remain active with three fingers. Once a
  // third finger joins, system navigation owns this contact sequence until release.
  let pinchBlocked = false;
  const cancelPinch = () => { pinchBlocked = true; interpreter.endPinch(); };
  const pinch = Gesture.Pinch().runOnJS(true)
    .onTouchesDown(event => {
      // iOS can deliver touches before BEGAN; only a fresh contact resets this.
      if (event.numberOfTouches === 1) pinchBlocked = false;
      else if (event.numberOfTouches > 2) cancelPinch();
    })
    .onTouchesUp(event => { if (event.numberOfTouches < 2) cancelPinch(); })
    .onTouchesCancelled(cancelPinch)
    .onStart(event => {
      if (event.numberOfPointers !== 2) cancelPinch();
      else if (!pinchBlocked) interpreter.beginPinch();
    })
    .onUpdate(event => {
      if (event.numberOfPointers !== 2) cancelPinch();
      else if (!pinchBlocked) interpreter.pinch(event.scale);
    })
    .onFinalize(() => { interpreter.endPinch(); pinchBlocked = false; });
  const threeFinger = multiFingerSwipe(3, interpreter);
  const fourFinger = multiFingerSwipe(4, interpreter);

  const taps = Gesture.Exclusive(rightTap, doubleTap, singleTap);
  return Gesture.Simultaneous(pointer, longPress, scroll, pinch, threeFinger, fourFinger, taps);
}
