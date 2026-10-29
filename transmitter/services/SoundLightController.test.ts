import { describe, expect, it } from 'vitest';
import type { ClientPayload } from '../../shared/protocol';
import { SoundLightController } from './SoundLightController';

const point = (degrees: number) => ({ x: 150 + 100 * Math.cos(degrees * Math.PI / 180), y: 150 + 100 * Math.sin(degrees * Math.PI / 180) });
function setup() {
  const packets: ClientPayload[] = [];
  const state = { enabled: true, session: 'mac-a/wifi', accepts: true };
  const controller = new SoundLightController({
    send: payload => { if (!state.accepts) return false; packets.push(payload); return true; },
    enabled: () => state.enabled,
    session: () => state.session,
  });
  const begin = (control: 'volume' | 'brightness' = 'volume') => controller.begin(point(0), { x: 150, y: 150 }, 60, control);
  const quarter = () => { for (let angle = 15; angle <= 90; angle += 15) controller.move(point(angle)); };
  return { controller, packets, state, begin, quarter };
}

describe('Sound & Light control delivery', () => {
  it.each(['volume', 'brightness'] as const)('sends proportional fine steps for %s', control => {
    const { packets, begin, quarter } = setup();
    begin(control); quarter();
    expect(packets.every(p => p.type === 'system_adjust' && p.control === control && p.steps > 0 && p.steps <= 16)).toBe(true);
    expect(packets.reduce((sum, p) => sum + (p.type === 'system_adjust' ? p.steps : 0), 0)).toBe(16);
  });

  it('sends negative steps for anticlockwise movement', () => {
    const { controller, packets, begin } = setup();
    begin();
    for (let angle = -15; angle >= -90; angle -= 15) controller.move(point(angle));
    expect(packets.reduce((sum, p) => sum + (p.type === 'system_adjust' ? p.steps : 0), 0)).toBe(-16);
  });

  it.each(['disabled', 'new session', 'extra finger', 'reset', 'send failed'] as const)('cancels the whole stroke after %s', reason => {
    const { controller, packets, state, begin, quarter } = setup();
    begin();
    if (reason === 'disabled') state.enabled = false;
    if (reason === 'new session') state.session = 'mac-b/bluetooth';
    if (reason === 'send failed') state.accepts = false;
    if (reason === 'reset') controller.reset();
    controller.move(point(15), reason === 'extra finger' ? 2 : 1);
    state.enabled = true; state.accepts = true; state.session = 'mac-a/wifi';
    quarter();
    expect(packets).toEqual([]);
    begin('brightness'); quarter();
    expect(packets.reduce((sum, p) => sum + (p.type === 'system_adjust' ? p.steps : 0), 0)).toBe(16);
  });

  it('does not start from the center button or while disconnected', () => {
    const { controller, packets, state, begin, quarter } = setup();
    controller.begin({ x: 150, y: 150 }, { x: 150, y: 150 }, 60, 'volume'); quarter();
    state.enabled = false; begin(); state.enabled = true; quarter();
    expect(packets).toEqual([]);
  });
});
