# Android release

## What members install today: the PWABuilder APK

The APK given to members was made with pwabuilder.com from `https://app.moshiur.space` (a Trusted Web Activity, package `space.moshiur.app.twa`). It is only a shell around the live site, so every deploy updates it; a new APK is needed only if the domain, name or icon changes.

- Download link for members: `https://github.com/moshiur-hridoy/tohobil/raw/apk/barakah.apk` (the `apk` branch holds only that file; `*.apk` is git-ignored on main).
- `apps/web/public/.well-known/assetlinks.json` carries the APK's signing fingerprint. With it the APK opens full screen; without it Android shows an address bar. A new APK signed with a different key needs its fingerprint added there.
- Bar colours: the top status bar follows the page (`<meta name="theme-color">`, kept in step with the light/dark theme by `syncStatusBar()` in `apps/web/src/lib/theme.ts`). The bottom navigation bar colour is fixed inside the APK when PWABuilder builds it. The first APK used the old lime manifest colour `#aff900` for both. For the next APK, in PWABuilder's Android options set "Status bar color" and "Splash screen background color" to `#f6f8f7`, "Navigation bar color" to `#ffffff` (the bottom menu's colour) and "Navigation bar color (dark)" to `#131a16`, and sign it with the **same** key (choose "Use mine" and upload the existing keystore), so members install it over the old one.
- The signing key from the PWABuilder zip stays outside the repo, backed up with the recovery kit. Losing it means members must uninstall and install a new APK.

The Capacitor build below is the later route (Play Store).

The Android app is a Capacitor shell that loads the production URL (`CAPACITOR_SERVER_URL`), so UI changes ship without a new APK. Package id: `app.barakah.fund`.

## One-time setup

```bash
pnpm install
pnpm --filter @barakah/web build
pnpm --filter @barakah/web exec cap add android   # creates apps/web/android/ (commit it)
```

Requirements: JDK 21 and the Android SDK (Capacitor 8). The native project is committed so release builds are reproducible; its build output, `local.properties` and signing material are git-ignored.

## Signing

Create the release keystore once, store it outside the repo, and back it up as described in `RECOVERY-KIT.md` (losing it means no more updates under this package id):

```bash
keytool -genkeypair -v -keystore barakah-release.jks -alias barakah-release -keyalg RSA -keysize 4096 -validity 36500
```

In `apps/web/android/app/build.gradle`, inside `android { ... }`, read the signing values from Gradle properties (`pnpm android:release` passes them from the environment):

```groovy
signingConfigs {
    release {
        if (project.hasProperty('BARAKAH_KEYSTORE_PATH')) {
            storeFile file(BARAKAH_KEYSTORE_PATH)
            storePassword BARAKAH_KEYSTORE_PASSWORD
            keyAlias BARAKAH_KEY_ALIAS
            keyPassword BARAKAH_KEY_PASSWORD
        }
    }
}
buildTypes {
    release {
        signingConfig signingConfigs.release
        minifyEnabled false
    }
}
```

## Build

```bash
export ANDROID_KEYSTORE_PATH=/secure/barakah-release.jks
export ANDROID_KEYSTORE_PASSWORD=...  ANDROID_KEY_ALIAS=barakah-release  ANDROID_KEY_PASSWORD=...
export CAPACITOR_SERVER_URL=https://fund.example
pnpm android:release
```

Artefacts: `apps/web/android/app/build/outputs/{apk,bundle}/release/`.

> Status: the release script and this procedure have **not** been exercised in Phase 0 (no Android SDK available during the audit). Run it once and fix any Gradle-version differences before relying on it. Phase 2 owns the push, battery-optimisation onboarding and in-app update banner.
