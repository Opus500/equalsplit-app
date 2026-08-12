import { ExpoConfig } from 'expo/config';

const BLUETOOTH_REASON =
  'EqualSplit connects to your timing gate over Bluetooth to start runs and read times.';

const PHOTOS_REASON =
  'EqualSplit reads a video you recorded so you can mark the start and finish frames of a run.';

const SAVE_PHOTOS_REASON =
  'EqualSplit saves a run video back to your camera roll when you export it.';

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
    // Video timing, Stage 1: import and mark. NO options on purpose — passing
    // supportsBackgroundPlayback/PictureInPicture as false makes this plugin
    // FILTER 'audio' out of UIBackgroundModes, which expo-audio (above) put there
    // and the run beeps depend on. With no options it no-ops on Info.plist, which
    // is right: we frame-step a local clip and never play media in the background.
    'expo-video',
    'expo-image',
    // Camera and microphone are refused. Stage 1 has no in-app capture — clips come
    // from the system camera via the library. NOTE for Stage 2: cameraPermission
    // must become a string here, NOT be set in ios.infoPlist. This plugin owns
    // NSCameraUsageDescription and its createPermissionsPlugin DELETES the key when
    // passed false, overwriting anything infoPlist sets.
    [
      'expo-image-picker',
      {
        photosPermission: PHOTOS_REASON,
        cameraPermission: false,
        microphonePermission: false,
      },
    ],
    // Export to camera roll. photosPermission is passed the SAME string as the
    // picker above, deliberately: both plugins run createPermissionsPlugin over
    // NSPhotoLibraryUsageDescription, so whichever executes last wins. Passing
    // false here would DELETE the key the picker needs for import, and omitting it
    // would let this plugin overwrite the message with its generic default.
    // Identical strings make plugin order irrelevant.
    [
      'expo-media-library',
      {
        photosPermission: PHOTOS_REASON,
        savePhotosPermission: SAVE_PHOTOS_REASON,
        isAccessMediaLocationEnabled: false,
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
