import { describe, expect, it } from 'vitest';
import { actionStepName, gestureMappingName, gestureSteps, sanitizeGestureMappings, sanitizeGestureStep } from './gestureSettings';

describe('gesture action sequences', () => {
  it('restores ordered phone, Mac, command and built-in steps without changing their identifiers', () => {
    const steps = [
      { type: 'open_app', target: 'mobile', appId: 'com.whatsapp', appName: 'WhatsApp' },
      { type: 'open_app', target: 'server', appId: '/Applications/Notes.app', appName: 'Notes' },
      { type: 'run_command', command: 'printf "hello world"\n' },
      { type: 'system', action: 'screenshot' },
    ];
    const saved = sanitizeGestureMappings({ left: steps });
    expect(gestureSteps('left', saved)).toEqual(steps);
    expect(gestureMappingName(saved.left)).toBe('4 actions');
    expect(actionStepName(gestureSteps('left', saved)[0]!)).toBe('Open WhatsApp on phone');
    steps.reverse();
    expect(gestureSteps('left', saved)[0]).toMatchObject({ appId: 'com.whatsapp' });
  });
  it('adapts old single actions, disabled values and explicit empty lists', () => {
    const saved = sanitizeGestureMappings({ left: 'lock', right: [], single: 'none', left_right: [{ type: 'system', action: 'photo_booth' }] });
    expect(gestureSteps('left', saved)).toEqual([{ type: 'system', action: 'lock' }]);
    expect(gestureSteps('right', saved)).toEqual([]);
    expect(gestureSteps('single', saved)).toEqual([]);
    expect(gestureSteps('left_straight', saved)).toEqual([{ type: 'system', action: 'photo_booth' }]);
    expect(gestureSteps('__proto__', saved)).toEqual([]);
    expect(gestureMappingName(saved.right)).toBe('Disabled');
  });
  it('drops malformed steps without reverting the gesture to its default action', () => {
    const invalid = [null, 'lock', { type: 'system', action: 'none' }, { type: 'system', action: 'run_command' },
      { type: 'open_app', target: 'elsewhere', appId: 'example' }, { type: 'open_app', target: 'mobile', appId: '' },
      { type: 'run_command', command: '  ' }, { type: 'run_command', command: 'echo\0hello' }];
    expect(gestureSteps('left', sanitizeGestureMappings({ left: invalid }))).toEqual([]);
  });
  it('bounds list length and returns independent action snapshots', () => {
    const saved = sanitizeGestureMappings({ left: Array.from({ length: 21 }, () => ({ type: 'system', action: 'lock' })) });
    const snapshot = gestureSteps('left', saved);
    expect(snapshot).toHaveLength(20);
    snapshot.length = 0;
    expect(gestureSteps('left', saved)).toHaveLength(20);
  });

  it('retains both URL destinations in a mixed list and trims only the outer whitespace', () => {
    const phoneUrl = 'HTTPS://example.com/search?q=one%20two&next=%2Fhome#results';
    const steps = [
      { type: 'system', action: 'screenshot' },
      { type: 'open_url', target: 'mobile', url: `  ${phoneUrl}\n` },
      { type: 'open_url', target: 'server', url: 'http://myserver.local:3001/status?raw=1#top' },
      { type: 'run_command', command: 'true' },
    ];
    const saved = sanitizeGestureMappings({ left: steps });
    const restored = gestureSteps('left', saved);
    expect(restored).toEqual([
      steps[0], { type: 'open_url', target: 'mobile', url: phoneUrl }, steps[2], steps[3],
    ]);
    expect(actionStepName(restored[1]!)).toBe('Open URL on Phone');
    expect(actionStepName(restored[2]!)).toBe('Open URL on Mac');
    expect(gestureMappingName([restored[1]!])).toBe('Open URL on Phone');
    expect(gestureMappingName(saved.left)).toBe('4 actions');
  });

  it.each([
    '', 'example.com', '//example.com/path', 'https:///path', 'http://',
    'javascript:alert(1)', 'file:///tmp/example', 'mailto:person@example.com',
    'https://example.com/a b', 'https://example.com/a\nb', 'https://example.com/\u0000',
    'https://example.com/\u007f', 'https://example.com/\\escape',
    'https://user@example.com', 'https://user:password@example.com',
    'https://example.com/' + 'x'.repeat(4096),
  ])('rejects an unsupported or malformed URL: %j', url => {
    expect(sanitizeGestureStep({ type: 'open_url', target: 'mobile', url })).toBeNull();
    expect(sanitizeGestureStep({ type: 'open_url', target: 'server', url })).toBeNull();
  });

  it('requires an explicit URL destination and keeps the existing action fields separate', () => {
    expect(sanitizeGestureStep({ type: 'open_url', target: 'other', url: 'https://example.com' })).toBeNull();
    expect(sanitizeGestureStep({ type: 'open_url', target: 'mobile', appId: 'https://example.com' })).toBeNull();
    expect(sanitizeGestureStep({ type: 'open_url', target: 'server', url: 3 })).toBeNull();
    expect(sanitizeGestureStep({ type: 'open_url', target: 'server', url: 'https://example.com', appId: 'ignored', command: 'ignored' })).toEqual({ type: 'open_url', target: 'server', url: 'https://example.com' });
  });
});
