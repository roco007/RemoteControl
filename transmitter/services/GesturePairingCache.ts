import type { GestureConfiguration } from '../modules/gesture-service';
export type GesturePairing = Pick<GestureConfiguration, 'serverId' | 'token' | 'deviceId' | 'deviceName'>;

export class GesturePairingCache {
  value: GesturePairing | null = null;
  private generation = 0;
  cancelPending() { this.generation += 1; }
  clear() { this.cancelPending(); this.value = null; }
  async load(lookup: () => Promise<GesturePairing | null>): Promise<GesturePairing | null | undefined> {
    const generation = ++this.generation;
    const next = await lookup();
    if (generation !== this.generation) return undefined;
    this.value = next;
    return this.value;
  }
}
