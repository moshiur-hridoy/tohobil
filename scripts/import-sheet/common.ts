import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

/** Repo root, whatever directory pnpm started the script from. */
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function loadEnv(): void {
  try {
    process.loadEnvFile(join(ROOT, '.env'));
  } catch {
    // No .env file: rely on the process environment.
  }
}

/** `--name value` or `--name=value`. */
export function flagValue(argv: readonly string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * A folder given on the command line. pnpm runs the script inside apps/api, so a relative path is
 * read from where the user typed the command (INIT_CWD), not from there.
 */
export function pathFlag(argv: readonly string[], name: string): string | undefined {
  const value = flagValue(argv, name);
  return value === undefined ? undefined : resolve(process.env['INIT_CWD'] ?? process.cwd(), value);
}

export const DEFAULT_RAW = join(ROOT, 'import', 'raw');
export const DEFAULT_NORMALIZED = join(ROOT, 'import', 'normalized');
export const DEFAULT_REVIEW = join(ROOT, 'import', 'review.csv');
