import { MessageType, PROTOCOL, type ClientPayload } from '../../shared/protocol';

export type InputSender = (payload: ClientPayload) => boolean | void;
type Delta = { dx: number; dy: number };
const clamp = (value: number) => Math.max(-PROTOCOL.maxDelta, Math.min(PROTOCOL.maxDelta, value));

/** Keeps the high-frequency path out of React and never buffers across sessions. */
export class InputEngine {
  private movement: Delta = { dx: 0, dy: 0 };
  private scrolling: Delta = { dx: 0, dy: 0 };
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private sender: InputSender) {}
  move = (dx: number, dy: number): void => this.accumulate(this.movement, dx, dy);
  scroll = (dx: number, dy: number): void => this.accumulate(this.scrolling, dx, dy);

  private accumulate(target: Delta, dx: number, dy: number) {
    if (this.disposed || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    target.dx = clamp(target.dx + dx); target.dy = clamp(target.dy + dy);
    this.timer ??= setTimeout(this.flush, 16);
  }

  flush = (): void => {
    clearTimeout(this.timer); this.timer = undefined;
    for (const [delta, type] of [[this.movement, MessageType.mouse_move], [this.scrolling, MessageType.mouse_scroll]] as const) {
      if (delta.dx || delta.dy) this.sender({ type, dx: delta.dx, dy: delta.dy });
      delta.dx = delta.dy = 0;
    }
  };

  send = (payload: ClientPayload): boolean => {
    if (this.disposed) return false;
    this.flush();
    return this.sender(payload) !== false;
  };

  clear = (): void => {
    clearTimeout(this.timer); this.timer = undefined;
    this.movement.dx = this.movement.dy = this.scrolling.dx = this.scrolling.dy = 0;
  };

  releaseAll = (): void => { this.clear(); if (!this.disposed) this.sender({ type: MessageType.release_all }); };
  dispose = (): void => { this.releaseAll(); this.disposed = true; };
}
