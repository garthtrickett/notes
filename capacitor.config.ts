import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.garthtrickett.notes',
  appName: 'notes',
  webDir: 'dist',
  // A sideloaded APK is a release build, and Capacitor's default logging
  // behaviour drops console output on the floor there — which is why a hang
  // on this flow has been mute for five builds. 'production' keeps the bridge
  // talking to logcat so an emulator can watch what the phone will not say.
  loggingBehavior: 'production'
};

export default config;
