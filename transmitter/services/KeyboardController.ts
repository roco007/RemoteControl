import { MessageType, PROTOCOL, type Key, type Modifier } from '../../shared/protocol';
import type { InputSender } from './InputEngine';

const isModifier = (key: Key): key is Modifier => (PROTOCOL.modifiers as readonly string[]).includes(key);
const NO_REPEAT: readonly Key[] = ['caps_lock', ...PROTOCOL.modifiers];
const REPEAT_DELAY = 450;
const REPEAT_INTERVAL = 55;

/** Physical event lifecycles, sticky modifier state, and bounded key repeat. */
export class KeyboardController {
  private held = new Set<Key>();
  private modifiers = new Set<Modifier>();
  private repeatTimers = new Map<Key, ReturnType<typeof setTimeout>>();
  private capsLock = false;
  private listeners = new Set<() => void>();

  constructor(private send: InputSender) {}
  getModifiers = (): Modifier[] => [...this.modifiers];
  getCapsLock = (): boolean => this.capsLock;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private notify() { this.listeners.forEach(listener => listener()); }

  press = (key: Key): void => {
    if (this.held.has(key) || isModifier(key)) return;
    const accepted = this.send({ type: MessageType.keyboard_down, key, modifiers: this.getModifiers(), repeat: false });
    if (accepted === false) return;
    this.held.add(key);
    if (key === 'caps_lock') { this.capsLock = !this.capsLock; this.notify(); }
    if (!NO_REPEAT.includes(key)) this.repeatTimers.set(key, setTimeout(() => this.repeat(key), REPEAT_DELAY));
  };

  private repeat(key: Key) {
    if (!this.held.has(key)) return;
    if (this.send({ type: MessageType.keyboard_down, key, modifiers: this.getModifiers(), repeat: true }) === false) {
      this.reset(); return;
    }
    this.repeatTimers.set(key, setTimeout(() => this.repeat(key), REPEAT_INTERVAL));
  }

  release = (key: Key): void => {
    clearTimeout(this.repeatTimers.get(key)); this.repeatTimers.delete(key);
    if (!this.held.delete(key)) return;
    this.send({ type: MessageType.keyboard_up, key, modifiers: this.getModifiers() });
  };

  toggleModifier = (modifier: Modifier): boolean => {
    if (this.modifiers.has(modifier)) {
      this.modifiers.delete(modifier);
      const accepted = this.send({ type: MessageType.keyboard_up, key: modifier, modifiers: this.getModifiers() });
      this.notify();
      return accepted !== false;
    } else {
      const next = [...this.modifiers, modifier];
      if (this.send({ type: MessageType.keyboard_down, key: modifier, modifiers: next, repeat: false }) === false) return false;
      this.modifiers.add(modifier); this.notify();
      return true;
    }
  };

  /** Run exactly the named shortcut, then restore the user's sticky selection. */
  shortcut = (key: Key, modifiers: readonly Modifier[]): void => {
    const previous = this.getModifiers();
    this.reset();
    for (const modifier of new Set(modifiers)) {
      if (!this.toggleModifier(modifier)) { this.reset(); return; }
    }
    this.press(key); this.release(key); this.reset();
    for (const modifier of previous) if (!this.toggleModifier(modifier)) break;
  };

  /** Unicode composition is explicitly separate from shortcuts and held keys. */
  text = (text: string): void => {
    if (!text.length) return;
    this.reset();
    // Split by code points without cutting UTF-16 surrogate pairs.
    let chunk = '';
    for (const character of text) {
      if (chunk.length + character.length > PROTOCOL.maxTextLength) {
        if (this.send({ type: MessageType.keyboard_text, text: chunk }) === false) return;
        chunk = '';
      }
      chunk += character;
    }
    if (chunk) this.send({ type: MessageType.keyboard_text, text: chunk });
  };

  reset = (): void => {
    const changed = this.modifiers.size > 0;
    this.repeatTimers.forEach(timer => clearTimeout(timer)); this.repeatTimers.clear();
    this.held.clear(); this.modifiers.clear();
    this.send({ type: MessageType.release_all });
    if (changed) this.notify();
  };
}
