import { MessageType, type Direction } from '../../shared/protocol';
import type { InputEngine } from '../services/InputEngine';
import type { Settings } from '../services/settings';

type GestureInput = Pick<InputEngine, 'send' | 'move' | 'scroll' | 'clear' | 'releaseAll'>;
const SWIPE_DISTANCE = 55;
const PINCH_STEP = Math.log(1.18);

/** Pure interpretation; recognizer lifecycles live in createTrackpadGesture. */
export class GestureInterpreter {
  private pointerX = 0;
  private pointerY = 0;
  private pointerCount = 1;
  private scrollX = 0;
  private scrollY = 0;
  private scrollCount = 2;
  private dragging = false;
  private zooming = false;
  private pinchLog = 0;

  constructor(private input: GestureInput, private settings: () => Settings, private haptic: () => void = () => {}) {}
  private feedback() { if (this.settings().haptics) this.haptic(); }

  tap = (): void => {
    if (this.settings().tapToClick && this.input.send({ type: MessageType.mouse_click, button: 'left', count: 1 })) this.feedback();
  };
  doubleTap = (): void => {
    if (this.settings().tapToClick && this.input.send({ type: MessageType.mouse_click, button: 'left', count: 2 })) this.feedback();
  };
  rightTap = (): void => {
    if (this.settings().twoFingerRightClick && this.input.send({ type: MessageType.mouse_click, button: 'right', count: 1 })) this.feedback();
  };

  beginPointer = (x: number, y: number): void => { this.pointerX = x; this.pointerY = y; this.pointerCount = 1; };
  pointer = (x: number, y: number, pointers: number, vx = 0, vy = 0): void => {
    const dx = x - this.pointerX; const dy = y - this.pointerY;
    this.pointerX = x; this.pointerY = y;
    const previousCount = this.pointerCount; this.pointerCount = pointers;
    if (pointers !== 1 || previousCount !== 1 || this.zooming) return;
    // A discontinuity is discarded, never converted into a cursor teleport.
    if (![dx, dy, vx, vy].every(Number.isFinite) || Math.abs(dx) > 160 || Math.abs(dy) > 160) return;
    const speed = Math.hypot(vx, vy);
    const acceleration = 1 + Math.min(0.65, Math.max(0, speed - 350) / 1700);
    const scale = this.settings().pointerSensitivity * acceleration;
    this.input.move(dx * scale, dy * scale);
  };

  beginDrag = (): void => {
    if (!this.dragging && this.input.send({ type: MessageType.mouse_down, button: 'left' })) { this.dragging = true; this.feedback(); }
  };
  endDrag = (): void => {
    if (!this.dragging) return;
    this.dragging = false;
    this.input.send({ type: MessageType.mouse_up, button: 'left' });
  };

  beginScroll = (x: number, y: number, pointers = 2): void => {
    this.scrollX = x; this.scrollY = y; this.scrollCount = pointers;
  };
  scroll = (x: number, y: number, pointers: number): void => {
    const dx = x - this.scrollX; const dy = y - this.scrollY;
    this.scrollX = x; this.scrollY = y;
    const previousCount = this.scrollCount; this.scrollCount = pointers;
    if (pointers !== 2 || previousCount !== 2 || this.zooming) return;
    if (![dx, dy].every(Number.isFinite) || Math.abs(dx) > 160 || Math.abs(dy) > 160) return;
    const settings = this.settings();
    const scale = settings.scrollSensitivity * (settings.naturalScroll ? 1 : -1);
    this.input.scroll(dx * scale, dy * scale);
  };

  beginPinch = (): void => { this.zooming = true; this.pinchLog = 0; this.input.clear(); this.endDrag(); };
  pinch = (scale: number): void => {
    if (!this.zooming || !Number.isFinite(scale) || scale <= 0) return;
    const logarithm = Math.log(scale);
    if (Math.abs(logarithm - this.pinchLog) >= PINCH_STEP) {
      const amount = logarithm > this.pinchLog ? 1 : -1;
      this.pinchLog = logarithm;
      this.input.send({ type: MessageType.mouse_gesture, gesture: 'zoom', amount });
    }
  };
  endPinch = (): void => { this.zooming = false; };

  beginSwipe = (): void => {
    this.input.clear();
    this.endDrag();
    this.endPinch();
  };

  swipe = (fingers: 3 | 4, dx: number, dy: number): void => {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const horizontal = Math.abs(dx) > Math.abs(dy) * 1.25;
    const vertical = Math.abs(dy) > Math.abs(dx) * 1.25;
    if ((!horizontal && !vertical) || Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_DISTANCE) return;
    const direction: Direction = horizontal ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    if (this.input.send({ type: MessageType.mouse_gesture, gesture: 'swipe', direction, fingers })) this.feedback();
  };

  reset = (): void => {
    this.dragging = false; this.zooming = false; this.pinchLog = 0;
    this.input.releaseAll();
  };
}
