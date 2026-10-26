import type { SocketFactory, SocketLike } from './types';

// Web browsers supply their own Origin, which the receiver must explicitly allow.
export const createSocket: SocketFactory = url => new WebSocket(url) as unknown as SocketLike;
