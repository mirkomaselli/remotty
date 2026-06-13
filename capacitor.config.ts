import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.remotty.mobile',
  appName: 'Remotty',
  webDir: 'web/dist-android',
  backgroundColor: '#0a0a0f',
  server: {
    androidScheme: 'https',
    cleartext: true,
    allowNavigation: ['*'],
  },
  android: {
    backgroundColor: '#0a0a0f',
  },
};

export default config;
