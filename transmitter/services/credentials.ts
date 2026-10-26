import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import type { CredentialStore, Identity } from '../networking/types';

// Browser previews deliberately do not persist remote-control secrets.
const memory = new Map<string, string>();
const options: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const read = (key: string) => Platform.OS === 'web' ? Promise.resolve(memory.get(key) ?? null) : SecureStore.getItemAsync(key, options);
const write = async (key: string, value: string) => {
  if (Platform.OS === 'web') memory.set(key, value);
  else await SecureStore.setItemAsync(key, value, options);
};
const tokenKey = (serverId: string) => `remote-mac.token.${serverId}`;
let identityPromise: Promise<Identity> | undefined;

export const credentials: CredentialStore = {
  getIdentity() {
    return identityPromise ??= (async () => {
      let deviceId = await read('remote-mac.device-id');
      if (!deviceId || !/^[a-f0-9-]{36}$/i.test(deviceId)) {
        deviceId = Crypto.randomUUID();
        await write('remote-mac.device-id', deviceId);
      }
      return { deviceId, deviceName: Platform.OS === 'ios' ? 'iPhone / iPad' : Platform.OS === 'android' ? 'Android phone' : 'Browser preview' };
    })().catch(error => { identityPromise = undefined; throw error; });
  },
  getToken(serverId) { return read(tokenKey(serverId)); },
  setToken(serverId, token) { return write(tokenKey(serverId), token); },
  async removeToken(serverId) {
    if (Platform.OS === 'web') memory.delete(tokenKey(serverId));
    else await SecureStore.deleteItemAsync(tokenKey(serverId), options);
  },
};
