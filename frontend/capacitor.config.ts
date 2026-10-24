import type { CapacitorConfig } from "@capacitor/cli";

// Icons/splash sources for @capacitor/assets live in assets/. The Android app wraps the static on-device build (npm run build:static → out/).
const config: CapacitorConfig = {
  appId: "app.marginalia.study",
  appName: "Marginalia",
  webDir: "out",
  android: {
    // Keep the WebView alive while long jobs (indexing a textbook, transcribing) run.
    allowMixedContent: false,
  },
  plugins: {
    LocalNotifications: {
      smallIcon: "ic_stat_icon",
      iconColor: "#b5472a",
    },
    // Google sign-in for Drive sync only (other providers left out of the APK).
    SocialLogin: {
      providers: { google: true, facebook: false, apple: false, twitter: false },
      logLevel: 1,
    },
    SplashScreen: {
      launchShowDuration: 800,
      backgroundColor: "#f5f0e6",
      showSpinner: false,
    },
  },
};

export default config;
