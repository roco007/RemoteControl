/** Kept independent of the native runtime's partial URL implementation. */
export const MAX_OPEN_URL_LENGTH = 4096;
const ipv4 = (host: string) => {
  const parts = host.split('.');
  return parts.length === 4 && parts.every(part => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
};
const ipv6 = (host: string) => {
  const halves = host.split('::');
  if (halves.length > 2) return false;
  const groups = halves.flatMap(half => half ? half.split(':') : []);
  let count = 0;
  for (const [index, group] of groups.entries()) {
    if (group.includes('.')) {
      if (index !== groups.length - 1 || !host.endsWith(group) || !ipv4(group)) return false;
      count += 2;
    } else {
      if (!/^[a-f0-9]{1,4}$/i.test(group)) return false;
      count += 1;
    }
  }
  return halves.length === 2 ? count < 8 : count === 8;
};
const hostname = (host: string) => {
  if (!host || host.length > 253) return false;
  if (/^[0-9.]+$/.test(host) && host.includes('.')) return ipv4(host);
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  return name.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
};
export function isOpenUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_OPEN_URL_LENGTH ||
      /[\s\\\u0000-\u001f\u007f-\u009f<>"{}|^`]/u.test(value) || /%(?![a-f0-9]{2})/i.test(value)) return false;
  const match = /^https?:\/\/([^/?#]+)/i.exec(value);
  if (!match) return false;
  const authority = match[1]!;
  if (/[\[\]]/.test(value.slice(match[0].length))) return false;
  let host: string, port: string | undefined;
  if (authority.startsWith('[')) {
    const bracketed = /^\[([^\]]+)\](?::([0-9]+))?$/.exec(authority);
    if (!bracketed || !ipv6(bracketed[1]!)) return false;
    host = bracketed[1]!; port = bracketed[2];
  } else {
    const ordinary = /^([^:]+)(?::([0-9]+))?$/.exec(authority);
    if (!ordinary || !hostname(ordinary[1]!)) return false;
    host = ordinary[1]!; port = ordinary[2];
  }
  return !!host && (port === undefined || Number(port) <= 65535);
}
export function normalizeOpenUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return isOpenUrl(trimmed) ? trimmed : null;
}
