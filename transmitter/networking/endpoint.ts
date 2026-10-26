import { PROTOCOL } from '../../shared/protocol';

export interface Endpoint { host: string; port: number; secure?: boolean }

/** Accept a host, never a URL path, credentials, query, or arbitrary scheme. */
export function normalizeEndpoint(endpoint: Endpoint): Endpoint {
  const host = endpoint.host.trim().replace(/^\[(.*)\]$/, '$1');
  const port = Number(endpoint.port);
  if (!host || host.length > 253 || !/^[a-zA-Z0-9_.:%-]+$/.test(host) || host.includes('..')) {
    throw new Error('Enter a Mac hostname or IP address, without http:// or a path.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
  return { host, port, secure: endpoint.secure === true };
}

export function endpointURL(endpoint: Endpoint): string {
  const e = normalizeEndpoint(endpoint);
  const host = e.host.includes(':') ? `[${e.host}]` : e.host;
  return `${e.secure ? 'wss' : 'ws'}://${host}:${e.port}`;
}

export const defaultEndpoint: Endpoint = { host: '', port: PROTOCOL.defaultPort };
