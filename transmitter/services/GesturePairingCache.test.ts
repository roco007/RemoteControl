import { describe, expect, it } from 'vitest';
import { GesturePairingCache, type GesturePairing } from './GesturePairingCache';

const profile: GesturePairing = { serverId: 'mac-a', token: 'paired-token', deviceId: 'phone', deviceName: 'Phone' };
function deferred() { let resolve!: (value: GesturePairing) => void; const promise = new Promise<GesturePairing>(yes => { resolve = yes; }); return { promise, resolve }; }

describe('gesture pairing credential lifetime', () => {
  it('cannot resurrect the widget profile when an old lookup finishes after disconnect', async () => {
    const cache = new GesturePairingCache();
    const lookup = deferred();
    const pending = cache.load(() => lookup.promise);
    cache.clear();
    lookup.resolve(profile);
    expect(await pending).toBeUndefined();
    expect(cache.value).toBeNull();
    expect(await cache.load(async () => profile)).toEqual(profile);
  });
  it('keeps the new Mac pairing when an earlier lookup completes later', async () => {
    const cache = new GesturePairingCache();
    const lookup = deferred();
    const pending = cache.load(() => lookup.promise);
    const next = { ...profile, serverId: 'mac-b', token: 'new-paired-token' };
    await cache.load(async () => next);
    lookup.resolve(profile); await pending;
    expect(cache.value).toEqual(next);
  });
});
