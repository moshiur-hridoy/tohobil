# Android release

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
