import { ExpoConfig } from 'expo/config';

const BLUETOOTH_REASON =
  'EqualSplit connects to your timing gate over Bluetooth to start runs and read times.';

const config: ExpoConfig = {
  name: 'EqualSplit',
  slug: 'equalsplit-app',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  scheme: 'equalsplit',
  userInterfaceStyle: 'light',
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.equalsplit.app',
    infoPlist: {
      NSBluetoothAlwaysUsageDescription: BLUETOOTH_REASON,
      NSBluetoothPeripheralUsageDescription: BLUETOOTH_REASON,
    },
  },
  android: {
    package: 'com.equalsplit.app',
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    'expo-dev-client',
    'expo-sqlite',
    [
      'react-native-ble-plx',
      {
        // Phone is BLE central only; no background scanning in v1.
        isBackgroundEnabled: false,
        modes: ['central'],
        bluetoothAlwaysPermission: BLUETOOTH_REASON,
      },
    ],
  ],
  extra: {
    eas: {
      projectId: '1914d19a-0d6d-4790-beba-96526c134f17',
    },
  },
};

export default config;
