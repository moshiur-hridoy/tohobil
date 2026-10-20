// Builds a signed Android release (spec 8): `pnpm android:release`.
//
// Signing material comes from the environment, never from the repo:
//   ANDROID_KEYSTORE_PATH       path to the release keystore (.jks)
//   ANDROID_KEYSTORE_PASSWORD   keystore password
//   ANDROID_KEY_ALIAS           key alias (RECOVERY-KIT.md: barakah-release)
//   ANDROID_KEY_PASSWORD        key password
//   CAPACITOR_SERVER_URL        production origin the app shell loads (https)
//
// The keystore is irreplaceable: losing it means no more updates under the same package id.
// Back it up as described in docs/RECOVERY-KIT.md BEFORE the first release.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = resolve(fileURLToPath(new URL('..', import.meta.url)));

const required = [
  'ANDROID_KEYSTORE_PATH',
  'ANDROID_KEYSTORE_PASSWORD',
  'ANDROID_KEY_ALIAS',
  'ANDROID_KEY_PASSWORD',
  'CAPACITOR_SERVER_URL',
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}
if (!process.env.CAPACITOR_SERVER_URL.startsWith('https://')) {
  console.error('CAPACITOR_SERVER_URL must be an https:// origin.');
  process.exit(1);
}
if (!existsSync(process.env.ANDROID_KEYSTORE_PATH)) {
  console.error(`Keystore not found: ${process.env.ANDROID_KEYSTORE_PATH}`);
  process.exit(1);
}
if (!existsSync(resolve(webDir, 'android'))) {
  console.error(
    'The native project is missing. Create it once with:  pnpm --filter @barakah/web exec cap add android',
  );
  console.error(
    'Then wire the signing config as described in docs/ANDROID.md and commit apps/web/android/.',
  );
  process.exit(1);
}

function run(command, args, cwd = webDir) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('pnpm', ['build']);
run('pnpm', ['exec', 'cap', 'sync', 'android']);

// build.gradle reads these properties (docs/ANDROID.md); nothing secret is written to disk.
const gradle = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
run(
  gradle,
  [
    'assembleRelease',
    'bundleRelease',
    `-PBARAKAH_KEYSTORE_PATH=${resolve(process.env.ANDROID_KEYSTORE_PATH)}`,
    `-PBARAKAH_KEYSTORE_PASSWORD=${process.env.ANDROID_KEYSTORE_PASSWORD}`,
    `-PBARAKAH_KEY_ALIAS=${process.env.ANDROID_KEY_ALIAS}`,
    `-PBARAKAH_KEY_PASSWORD=${process.env.ANDROID_KEY_PASSWORD}`,
  ],
  resolve(webDir, 'android'),
);

console.log('Release artefacts: apps/web/android/app/build/outputs/{apk,bundle}/release/');
