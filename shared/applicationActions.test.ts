import { describe, expect, it } from 'vitest';
import { isClientMessage, parseMessage } from './protocol';

const wire = (payload: object) => JSON.stringify({ v: 1, seq: 1, timestamp: 1, ...payload });

describe('application and command protocol', () => {
  it('accepts correlated app launch and shell command requests', () => {
    for (const payload of [
      { type: 'system_action', action: 'open_app', appId: '/System/Applications/Calculator.app', id: 'app-1' },
      { type: 'system_action', action: 'run_command', command: 'printf "hello"', id: 'command-1' },
      { type: 'system_action', action: 'open_url', url: 'https://example.com/path?q=hello#section', id: 'url-1' },
    ]) {
      const parsed = parseMessage(wire(payload));
      expect(parsed).not.toBeNull();
      expect(parsed && isClientMessage(parsed)).toBe(true);
    }
  });
  it('requires the correct parameter and id without leaking parameters into other actions', () => {
    for (const payload of [
      { action: 'open_app', id: 'x' }, { action: 'open_app', appId: '/A.app' },
      { action: 'open_app', appId: '/A.app', command: 'pwd', id: 'x' },
      { action: 'run_command', command: '', id: 'x' }, { action: 'run_command', command: ' \n ', id: 'x' },
      { action: 'run_command', command: 'x\0y', id: 'x' },
      { action: 'run_command', command: 'x'.repeat(4097), id: 'x' },
      { action: 'lock', command: 'pwd', id: 'x' },
      { action: 'open_url', url: 'https://example.com/' + 'x'.repeat(4096), id: 'x' },
      { action: 'open_app', appId: '/A.app', url: 'https://example.com', id: 'x' },
      { action: 'run_command', command: 'true', url: 'https://example.com', id: 'x' },
    ]) expect(parseMessage(wire({ type: 'system_action', ...payload }))).toBeNull();
  });
  it('pages application catalogs over the authenticated client protocol', () => {
    const request = parseMessage(wire({ type: 'apps_list', id: 'list-1', cursor: 0 }));
    expect(request).not.toBeNull();
    expect(request && isClientMessage(request)).toBe(true);
    const response = parseMessage(wire({ type: 'apps_list_result', id: 'list-1', apps: [{ id: '/A.app', name: 'A', icon: 'data:image/png;base64,YQ==' }], nextCursor: 1 }));
    expect(response).not.toBeNull();
    expect(response && isClientMessage(response)).toBe(false);
  });
  it('rejects untrusted icon URLs, unknown app properties, and invalid cursors', () => {
    for (const app of [
      { id: '/A.app', name: 'A', icon: 'https://example.com/icon.png' },
      { id: '/A.app', name: 'A', command: 'pwd' },
      { id: '', name: 'A' },
    ]) expect(parseMessage(wire({ type: 'apps_list_result', id: 'x', apps: [app] }))).toBeNull();
    for (const cursor of [-1, 0.5, true, '2']) expect(parseMessage(wire({ type: 'apps_list', id: 'x', cursor }))).toBeNull();
  });
});
