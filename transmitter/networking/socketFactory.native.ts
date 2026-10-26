import { PROTOCOL } from '../../shared/constants';
import type { SocketFactory, SocketLike } from './types';

// The shared Expo tsconfig includes DOM types, whose constructor omits RN's options.
type NativeWebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
  options?: { headers: Record<string, string> },
) => SocketLike;

// React Native Android otherwise synthesizes an HTTP Origin from the socket URL.
// An explicit native Origin keeps the receiver's browser-origin restrictions intact.
export const createSocket: SocketFactory = url => {
  const NativeWebSocket = WebSocket as unknown as NativeWebSocketConstructor;
  return new NativeWebSocket(url, undefined, { headers: { Origin: PROTOCOL.nativeClientOrigin } });
};
