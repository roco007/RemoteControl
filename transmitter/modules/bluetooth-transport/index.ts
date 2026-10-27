import { requireOptionalNativeModule } from 'expo-modules-core';

export interface BluetoothDevice { id: string; name: string; rssi: number }
export type BluetoothState = 'unknown' | 'resetting' | 'unsupported' | 'unauthorized' | 'poweredOff' | 'poweredOn';
type Subscription = { remove(): void };
export interface BleBridge {
  startScan(serviceUUID: string): Promise<void>;
  stopScan(): Promise<void>;
  connect(deviceId: string, serviceUUID: string, writeUUID: string, notifyUUID: string): Promise<void>;
  send(message: string): Promise<void>;
  disconnect(): Promise<void>;
  addListener(name: 'onDevices', listener: (event: { devices: BluetoothDevice[] }) => void): Subscription;
  addListener(name: 'onData', listener: (event: { data: string }) => void): Subscription;
  addListener(name: 'onDisconnected' | 'onError', listener: (event: { message: string }) => void): Subscription;
  addListener(name: 'onState', listener: (event: { state: BluetoothState }) => void): Subscription;
  addListener(name: 'onAppState', listener: (event: { active: boolean }) => void): Subscription;
}

/** Expo Go and web deliberately expose no BLE bridge. A native app rebuild is required. */
export const bleBridge = requireOptionalNativeModule<BleBridge>('BluetoothTransport');
