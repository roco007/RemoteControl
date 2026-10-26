import { requireOptionalNativeModule } from 'expo-modules-core';
import { PROTOCOL } from '../../../shared/constants';

export interface DiscoveredMac { id: string; name: string; host: string; port: number }
type Subscription = { remove(): void };
interface DiscoveryModule {
  start(serviceType: string): Promise<void>;
  stop(): Promise<void>;
  requestLocalNetworkAccess(): Promise<boolean>;
  addListener(name: 'onChange', listener: (event: { macs: DiscoveredMac[] }) => void): Subscription;
  addListener(name: 'onError', listener: (event: { message: string }) => void): Subscription;
}

const native = requireOptionalNativeModule<DiscoveryModule>('LanDiscovery');
export const discoveryAvailable = native !== null;
export const discoveryUnavailableReason = 'Automatic discovery requires an Expo development build. Enter the Mac hostname or IP address below to connect manually.';
const errorListeners = new Set<(message: string) => void>();
const emitError = (message: string) => errorListeners.forEach(listener => listener(message));
let generation = 0;

/** Android 17+ only needs a runtime grant if the app targets API 37+. */
export async function requestLocalNetworkAccess(): Promise<boolean> {
  return native ? native.requestLocalNetworkAccess() : true;
}

export function startDiscovery(): void {
  const current = ++generation;
  if (!native) { emitError(discoveryUnavailableReason); return; }
  native.requestLocalNetworkAccess().then(granted => {
    if (generation !== current) return;
    if (!granted) { emitError('Local network permission was denied. Allow it in system settings to find your Mac.'); return; }
    return native.start(PROTOCOL.serviceType);
  }).catch(error => {
    if (generation === current) emitError(error instanceof Error ? error.message : 'Unable to search the local network.');
  });
}

export function stopDiscovery(): void {
  generation += 1;
  native?.stop().catch(() => { /* Native resources are also released on background/destruction. */ });
}

export function subscribeDiscovery(onChange: (macs: DiscoveredMac[]) => void, onError?: (message: string) => void): () => void {
  if (onError) errorListeners.add(onError);
  const change = native?.addListener('onChange', event => onChange(event.macs));
  const error = native?.addListener('onError', event => onError?.(event.message));
  return () => {
    change?.remove(); error?.remove();
    if (onError) errorListeners.delete(onError);
  };
}
