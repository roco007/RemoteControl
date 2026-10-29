import type { Settings } from './settings';

/** Local phone steps do not need a saved Wi-Fi receiver to listen in the background. */
export function backgroundGesturesEligible(settings: Pick<Settings, 'gestureMappings' | 'host' | 'transportMode'>): boolean {
  const hasPhoneActions = Object.values(settings.gestureMappings).some(mapping => Array.isArray(mapping) && mapping.some(step => (step.type === 'open_app' || step.type === 'open_url') && step.target === 'mobile'));
  return hasPhoneActions || (settings.transportMode !== 'bluetooth' && !!settings.host.trim());
}
