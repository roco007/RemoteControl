import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Remote Mac',
  slug: 'remote-mac-control',
  version: '1.0.0',
  scheme: 'remotemac',
  orientation: 'default',
  userInterfaceStyle: 'dark',
  icon: './assets/icon.png',
  extra: {
    eas: { projectId: 'cf921b52-24f6-4e02-88c1-f53f9b2c8ad5' },
  },
  ios: {
    bundleIdentifier: 'com.remotemac.transmitter',
    supportsTablet: true,
    infoPlist: {
      UIRequiresFullScreen: false,
      NSBluetoothAlwaysUsageDescription: 'Find and securely connect to your Mac over Bluetooth to control its pointer and keyboard when Wi-Fi is unavailable.',
    },
  },
  android: {
    package: 'com.remotemac.transmitter',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#C4F58A',
      monochromeImage: './assets/monochrome-icon.png',
    },
    permissions: ['INTERNET', 'ACCESS_NETWORK_STATE', 'ACCESS_WIFI_STATE', 'CHANGE_WIFI_MULTICAST_STATE'],
  },
  web: { name: 'Remote Mac', bundler: 'metro', favicon: './assets/favicon.png' },
  plugins: [
    'expo-secure-store',
    'expo-dev-client',
    './plugins/withLocalNetwork',
  ],
};

export default config;
