import { ExpoConfig } from 'expo/config';

const BLUETOOTH_REASON =
  'EqualSplit connects to your timing gate over Bluetooth to start runs and read times.';

const PHOTOS_REASON =
  'EqualSplit reads a video you recorded so you can mark the start and finish frames of a run.';

const CAMERA_REASON =
  'EqualSplit records a rep so you can mark the start and finish frames and time it.';

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
    appleTeamId: 'CPM8C3S84F',
    infoPlist: {
      NSBluetoothAlwaysUsageDescription: BLUETOOTH_REASON,
      NSBluetoothPeripheralUsageDescription: BLUETOOTH_REASON,
      // NSCameraUsageDescription is NOT set here. expo-image-picker's plugin owns
      // that key and its createPermissionsPlugin DELETES it when passed
      // cameraPermission: false, overwriting anything set here. So it is declared
      // on that plugin below instead — one key, one owner.
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
    // Playback only — no recording, so suppress the microphone permission.
    ['expo-audio', { microphonePermission: false }],
    'expo-asset',
    [
      'react-native-ble-plx',
      {
        // Phone is BLE central only; no background scanning in v1.
        isBackgroundEnabled: false,
        modes: ['central'],
        bluetoothAlwaysPermission: BLUETOOTH_REASON,
      },
    ],
    // SPIKE ONLY — video timing feasibility.
    // Deliberately NO options: passing supportsBackgroundPlayback/PictureInPicture
    // as false makes this plugin FILTER 'audio' out of UIBackgroundModes, which
    // expo-audio (above) put there and the run beeps depend on. With no options
    // the plugin no-ops on Info.plist, which is what we want — we frame-step a
    // local clip, we never play media in the background.
    'expo-video',
    // SPIKE: cameraPermission is no longer false. VisionCamera v5 ships no config
    // plugin, and this plugin owns NSCameraUsageDescription — passing false here
    // strips the key regardless of what ios.infoPlist says, so the camera silently
    // fails to open. Microphone stays refused: the spike records enableAudio false.
    [
      'expo-image-picker',
      {
        photosPermission: PHOTOS_REASON,
        cameraPermission: CAMERA_REASON,
        microphonePermission: false,
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
