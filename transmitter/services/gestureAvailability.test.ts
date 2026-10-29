import { describe, expect, it } from 'vitest';
import { backgroundGesturesEligible } from './gestureAvailability';
import { defaultSettings } from './settings';
import { sanitizeGestureMappings } from './gestureSettings';

describe('background gesture eligibility', () => {
  it.each(['wifi', 'bluetooth', 'automatic'] as const)('keeps phone URL-only gestures eligible without a Mac in %s mode', transportMode => {
    expect(backgroundGesturesEligible({ ...defaultSettings, host: '', transportMode, gestureMappings: sanitizeGestureMappings({ left: [{ type: 'open_url', target: 'mobile', url: 'https://example.com/' }] }) })).toBe(true);
  });
  it('still requires a saved Wi-Fi address for Mac URL-only gestures', () => {
    const settings = { ...defaultSettings, host: '', gestureMappings: sanitizeGestureMappings({ left: [{ type: 'open_url', target: 'server', url: 'https://example.com/' }] }) };
    expect(backgroundGesturesEligible(settings)).toBe(false);
    expect(backgroundGesturesEligible({ ...settings, host: 'mac.local', transportMode: 'wifi' })).toBe(true);
    expect(backgroundGesturesEligible({ ...settings, host: 'mac.local', transportMode: 'bluetooth' })).toBe(false);
  });
  it('preserves offline eligibility for an existing phone-app mapping', () => {
    expect(backgroundGesturesEligible({ ...defaultSettings, host: '', gestureMappings: sanitizeGestureMappings({ left: [{ type: 'open_app', target: 'mobile', appId: 'com.example.app' }] }) })).toBe(true);
  });
});
