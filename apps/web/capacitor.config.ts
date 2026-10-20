import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.barakah.fund',
  appName: 'Barakah Fund',
  webDir: 'dist',
  server: {
    // In production this points at the server URL so UI updates apply without a new APK.
    // Read from the environment at build time.
    url: process.env.CAPACITOR_SERVER_URL || undefined,
    androidScheme: 'https',
    // Shown when the server URL cannot be reached (offline fallback page, spec 8).
    errorPath: 'offline.html',
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
