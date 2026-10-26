import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSocket as createBrowserSocket } from './socketFactory';
import { createSocket as createNativeSocket } from './socketFactory.native';

afterEach(() => vi.unstubAllGlobals());

describe('platform WebSocket handshake', () => {
  it('identifies the native app instead of Android defaulting to an HTTP Origin', () => {
    const Socket = vi.fn(function () {});
    vi.stubGlobal('WebSocket', Socket);

    createNativeSocket('ws://127.0.0.1:9876');

    expect(Socket).toHaveBeenCalledWith('ws://127.0.0.1:9876', undefined, {
      headers: { Origin: 'remote-mac-control://native' },
    });
  });

  it('leaves the browser Origin under browser control', () => {
    const Socket = vi.fn(function () {});
    vi.stubGlobal('WebSocket', Socket);

    createBrowserSocket('ws://mac.local:9876');

    expect(Socket).toHaveBeenCalledWith('ws://mac.local:9876');
  });
});
