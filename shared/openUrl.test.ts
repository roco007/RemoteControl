import { describe, expect, it } from 'vitest';
import fixtures from './open-url-fixtures.json';
import { isOpenUrl, MAX_OPEN_URL_LENGTH, normalizeOpenUrl } from './openUrl';

describe('cross-platform HTTP URL validation', () => {
  it.each(fixtures.valid)('accepts %s', url => expect(isOpenUrl(url)).toBe(true));
  it.each(fixtures.invalid)('rejects %j', url => expect(isOpenUrl(url)).toBe(false));
  it('trims only in the editor helper and preserves URL contents', () => {
    expect(normalizeOpenUrl('  HTTPS://Example.COM/a%20b?q=hello#there  ')).toBe('HTTPS://Example.COM/a%20b?q=hello#there');
    expect(isOpenUrl(' https://example.com ')).toBe(false);
    expect(normalizeOpenUrl(null)).toBeNull();
    expect(normalizeOpenUrl('javascript:alert(1)')).toBeNull();
  });
  it('bounds UTF-16 length independently of the URL implementation', () => {
    const prefix = 'https://example.com/';
    expect(isOpenUrl(prefix + 'x'.repeat(MAX_OPEN_URL_LENGTH - prefix.length))).toBe(true);
    expect(isOpenUrl(prefix + 'x'.repeat(MAX_OPEN_URL_LENGTH + 1 - prefix.length))).toBe(false);
  });
});
