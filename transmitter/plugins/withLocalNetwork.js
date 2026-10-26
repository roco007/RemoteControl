const { withAndroidManifest, withInfoPlist } = require('expo/config-plugins');
const { serviceType } = require('../../shared/protocol-manifest.json');

/** LAN WebSockets intentionally use cleartext in v1; use only a trusted Wi-Fi LAN. */
module.exports = function withLocalNetwork(config, options = {}) {
  config = withInfoPlist(config, config => {
    config.modResults.NSLocalNetworkUsageDescription = 'Find your Mac and pair this phone to control its pointer and keyboard over Wi-Fi.';
    config.modResults.NSBonjourServices = Array.from(new Set([
      ...(config.modResults.NSBonjourServices || []), serviceType,
    ]));
    config.modResults.NSAppTransportSecurity = {
      ...(config.modResults.NSAppTransportSecurity || {}),
      NSAllowsLocalNetworking: true,
    };
    return config;
  });
  return withAndroidManifest(config, config => {
    const manifest = config.modResults.manifest;
    const app = manifest.application?.[0];
    if (app) app.$['android:usesCleartextTraffic'] = 'true';
    const permissions = [
      'android.permission.INTERNET',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.ACCESS_WIFI_STATE',
      'android.permission.CHANGE_WIFI_MULTICAST_STATE',
    ];
    // Android requires this runtime permission only when targeting API 37+.
    // SDK 58 defaults to target 36. Set this option when upgrading targetSdk.
    if (options.targetSdk37) permissions.push('android.permission.ACCESS_LOCAL_NETWORK');
    manifest['uses-permission'] ||= [];
    for (const permission of permissions) {
      if (!manifest['uses-permission'].some(entry => entry.$['android:name'] === permission)) {
        manifest['uses-permission'].push({ $: { 'android:name': permission } });
      }
    }
    return config;
  });
};
