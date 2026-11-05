// Says why the app wants the microphone and – on iOS – the system's speech recognition, in the
// app's own words. In app.json:
//
//   "plugins": [["@schaefchens/shama-react-native", {
//     "microphone": "Listens while you talk to the app.",
//     "speechRecognition": "What you say is recognized on this device."
//   }]]
// From the app first: a package linked from elsewhere resolves from where it really is.
const { AndroidConfig, withAndroidManifest, withInfoPlist } = require(
  require.resolve('expo/config-plugins', { paths: [process.cwd(), __dirname] }),
);

module.exports = function withShama(config, { microphone, speechRecognition } = {}) {
  config = withInfoPlist(config, (config) => {
    const plist = config.modResults;
    plist.NSMicrophoneUsageDescription = microphone ?? plist.NSMicrophoneUsageDescription ?? 'Listens while you talk to the app.';
    plist.NSSpeechRecognitionUsageDescription =
      speechRecognition ?? plist.NSSpeechRecognitionUsageDescription ?? 'What you say is recognized on this device.';
    return config;
  });
  return withAndroidManifest(config, (config) => {
    AndroidConfig.Permissions.ensurePermissions(config.modResults, ['android.permission.RECORD_AUDIO']);
    return config;
  });
};
