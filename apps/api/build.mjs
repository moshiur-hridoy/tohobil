// Bundles the API for production with esbuild.
//
// Why not plain `tsc`? The sources use extensionless relative imports and import the TypeScript-only
// workspace package @barakah/shared, so tsc's output cannot run under `node dist/index.js`
// (ERR_MODULE_NOT_FOUND). Bundling inlines the workspace code and keeps every real npm dependency
// external (installed in the image via `pnpm deploy --prod`), which also keeps native modules
// (argon2, sharp) working.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {});

await build({
  entryPoints: {
    index: 'src/index.ts',
    migrate: 'src/migrate.ts',
    healthcheck: 'src/healthcheck.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external,
  logLevel: 'info',
});
