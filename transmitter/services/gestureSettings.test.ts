import { describe, expect, it } from 'vitest';
import { defaultGestureMappings, defaultGestureOrders, sanitizeGestureMappings, sanitizeGestureOrders, gestureAction, gesturesForMode, reorderGesture } from './gestureSettings';

describe('gesture configuration', () => {
  it('provides the requested directional mappings and preserves count mappings', () => {
    expect(defaultGestureMappings).toEqual({ single: 'screenshot', double: 'kill_app', triple: 'lock', right: 'screenshot', left: 'lock', left_straight: 'kill_app', right_straight: 'photo_booth' });
  });
  it('preserves disabled gestures and valid customized actions', () => {
    expect(sanitizeGestureMappings({ right: 'none', left: 'photo_booth' })).toMatchObject({ right: 'none', left: 'photo_booth', double: 'kill_app' });
  });
  it('keeps saved lock mappings usable for Lock/Unlock Mac without migration', () => {
    const savedMappings = sanitizeGestureMappings(JSON.parse('{"left":"lock","triple":"lock","right":"none"}'));
    expect(savedMappings).toMatchObject({ left: 'lock', triple: 'lock', right: 'none' });
    expect(gestureAction('left', savedMappings, ['system_actions'])).toBe('lock');
    expect(gestureAction('triple', savedMappings, ['system_actions'])).toBe('lock');
  });
  it('rejects unknown actions, unlock and malformed saved mappings', () => {
    expect(sanitizeGestureMappings({ left: 'unlock', single: null, right: 'execute' })).toEqual(defaultGestureMappings);
    expect(sanitizeGestureMappings(null)).toEqual(defaultGestureMappings);
  });
  it('requires the advertised receiver capability and never sends disabled actions', () => {
    expect(gestureAction('right', defaultGestureMappings, ['system_actions'])).toBe('screenshot');
    expect(gestureAction('right_straight', defaultGestureMappings, ['system_actions'])).toBeNull();
    expect(gestureAction('right_straight', defaultGestureMappings, ['system_actions', 'photo_booth'])).toBe('photo_booth');
    expect(gestureAction('invalid', defaultGestureMappings, ['system_actions'])).toBeNull();
    expect(gestureAction('right', { ...defaultGestureMappings, right: 'none' }, ['system_actions'])).toBeNull();
    expect(gestureAction('left', defaultGestureMappings, [])).toBeNull();
  });
});

describe('gesture card order', () => {
  it('keeps the existing card order for settings saved before ordering was supported', () => {
    expect(sanitizeGestureOrders(undefined)).toEqual({ count: ['single', 'double', 'triple'], directional: ['right', 'left', 'left_straight', 'right_straight'] });
    expect(gesturesForMode('directional')).toEqual(['right', 'left', 'left_straight', 'right_straight']);
    expect(gesturesForMode('count')).toEqual(['single', 'double', 'triple']);
  });

  it('preserves valid positions, rejects duplicates and other-mode keys, and appends missing cards', () => {
    const orders = sanitizeGestureOrders({
      count: ['triple', 'right', 'single', 'triple', null],
      directional: ['left', 'left', 'single', 'unknown', 'right_straight'],
    });
    expect(orders).toEqual({ count: ['triple', 'single', 'double'], directional: ['left', 'right_straight', 'right', 'left_straight'] });
    expect(gesturesForMode('directional', orders)).toEqual(['left', 'right_straight', 'right', 'left_straight']);
  });

  it.each([{ value: null }, { value: 'left' }, { value: 3 }, { value: [] }, { value: { count: 'triple', directional: {} } }])('uses defaults for malformed saved order $value', ({ value }) => {
    expect(sanitizeGestureOrders(value)).toEqual({ count: ['single', 'double', 'triple'], directional: ['right', 'left', 'left_straight', 'right_straight'] });
  });

  it('isolates sanitized and displayed arrays from saved input and future defaults', () => {
    const saved = { count: ['triple', 'double', 'single'], directional: ['left', 'right', 'left_straight', 'right_straight'] };
    const orders = sanitizeGestureOrders(saved);
    saved.count.reverse();
    expect(orders.count).toEqual(['triple', 'double', 'single']);
    orders.directional.reverse();
    const displayed = gesturesForMode('count', orders);
    displayed.reverse();
    expect(orders.count).toEqual(['triple', 'double', 'single']);
    const defaults = sanitizeGestureOrders(undefined);
    defaults.count.reverse();
    defaults.directional.reverse();
    expect(sanitizeGestureOrders(undefined)).toEqual({ count: ['single', 'double', 'triple'], directional: ['right', 'left', 'left_straight', 'right_straight'] });
  });

  it('moves a card to any position without changing either mode in the previous settings', () => {
    const original = sanitizeGestureOrders(undefined);
    const directional = reorderGesture(original, 'directional', 'right_straight', 0);
    const bothModes = reorderGesture(directional, 'count', 'single', 2);
    expect(bothModes).toEqual({ count: ['double', 'triple', 'single'], directional: ['right_straight', 'right', 'left', 'left_straight'] });
    expect(directional.count).toEqual(['single', 'double', 'triple']);
    expect(original).toEqual({ count: ['single', 'double', 'triple'], directional: ['right', 'left', 'left_straight', 'right_straight'] });
    expect(reorderGesture(directional, 'directional', 'right_straight', 3).directional).toEqual(original.directional);
  });

  it('ignores invalid positions and cards belonging to another mode', () => {
    for (const index of [-1, 4, 0.5, NaN, Infinity]) {
      expect(reorderGesture(defaultGestureOrders, 'directional', 'right', index)).toEqual(defaultGestureOrders);
    }
    expect(reorderGesture(defaultGestureOrders, 'count', 'left', 1)).toEqual(defaultGestureOrders);
    expect(reorderGesture(defaultGestureOrders, 'directional', 'left', 1)).toEqual(defaultGestureOrders);
  });

  it('keeps actions attached to gesture names when cards move', () => {
    const mappings = sanitizeGestureMappings({ left: 'lock', right: 'photo_booth' });
    const reordered = reorderGesture(defaultGestureOrders, 'directional', 'left', 0);
    expect(gesturesForMode('directional', reordered).map(gesture => gestureAction(gesture, mappings, ['system_actions', 'photo_booth']))).toEqual(['lock', 'photo_booth', 'kill_app', 'photo_booth']);
    expect(gestureAction('left', mappings, ['system_actions'])).toBe('lock');
    expect(mappings.right).toBe('photo_booth');
  });
});

describe('straight gesture migration', () => {
  it('moves legacy action assignments to straight gestures without changing count actions', () => {
    const mappings = sanitizeGestureMappings({ left_right: 'photo_booth', right_left: 'none', single: 'lock', double: 'screenshot' });
    expect(mappings).toMatchObject({ left_straight: 'photo_booth', right_straight: 'none', single: 'lock', double: 'screenshot' });
    expect(gestureAction('left_straight', mappings, ['system_actions', 'photo_booth'])).toBe('photo_booth');
    expect(gestureAction('right_straight', mappings, ['system_actions'])).toBeNull();
    expect(gestureAction('left_right', mappings, ['system_actions', 'photo_booth'])).toBeNull();
    expect(mappings).not.toHaveProperty('left_right');
    expect(mappings).not.toHaveProperty('right_left');
  });

  it('keeps explicit new mappings when both legacy and new keys exist', () => {
    const mappings = sanitizeGestureMappings({ left_right: 'kill_app', left_straight: 'none', right_left: 'lock', right_straight: 'screenshot' });
    expect(mappings).toMatchObject({ left_straight: 'none', right_straight: 'screenshot' });
  });

  it('migrates legacy positions in place and preserves the separate count order', () => {
    const original = { directional: ['right_left', 'left', 'left_right', 'right'], count: ['triple', 'single', 'double'] };
    expect(sanitizeGestureOrders(original)).toEqual({ directional: ['right_straight', 'left', 'left_straight', 'right'], count: ['triple', 'single', 'double'] });
    expect(original.directional).toEqual(['right_left', 'left', 'left_right', 'right']);
  });

  it('keeps new-key positions when an order contains both names for a gesture', () => {
    const orders = sanitizeGestureOrders({ directional: ['left_right', 'right_left', 'right', 'left_straight', 'left', 'right_straight'] });
    expect(orders.directional).toEqual(['right', 'left_straight', 'left', 'right_straight']);
  });
});
