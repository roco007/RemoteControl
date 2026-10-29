import { expect, it } from 'vitest';
import { filterApplications, sanitizeApplications } from './applicationCatalog';
it('suggests names case-insensitively with prefix matches first and keeps catalog identity', () => {
  const apps = [{ id: 'wiki', name: 'Wikipedia' }, { id: 'browser', name: 'Browser' }, { id: 'weather', name: 'Weather' }, { id: 'whatsapp', name: 'WhatsApp' }];
  expect(filterApplications(apps, ' w ').map(a => a.id)).toEqual(['weather', 'whatsapp', 'wiki', 'browser']);
  expect(apps[0]!.id).toBe('wiki');
});
it('deduplicates by executable ID and allows only inline PNG icons', () => {
  expect(sanitizeApplications([{ id: 'one', name: 'Weather', icon: 'https://tracking.example/icon.png' }, { id: 'one', name: 'Duplicate' }, { id: 'two', name: 'Weather', icon: 'data:image/png;base64,aGVsbG8=' }, { id: '', name: 'Bad' }])).toEqual([{ id: 'one', name: 'Weather' }, { id: 'two', name: 'Weather', icon: 'data:image/png;base64,aGVsbG8=' }]);
});
