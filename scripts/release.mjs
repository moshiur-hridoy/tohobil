#!/usr/bin/env node
/**
 * Release `dev` to `main` as the next version (docs/RELEASES.md):
 *
 *   pnpm release minor            # new features: 1.7.0 -> 1.8.0
 *   pnpm release patch            # fixes only:   1.8.0 -> 1.8.1
 *   pnpm release major            # a big change: 1.8.1 -> 2.0.0
 *
 * Options: --no-checks skips lint, types and tests; --trailer "Key: value" is added to the commit.
 *
 * Steps: the "## অপ্রকাশিত" section of CHANGELOG.md (written in Bengali, at least one change) becomes
 * "## X.Y.Z (today in Dhaka)", every package.json gets the version, the checks run, then the release
 * commit goes on dev, main is fast-forwarded to it, and the tag vX.Y.Z is pushed. GitHub builds the
 * images under that tag, which is what Portainer's TAG is set to.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const PACKAGES = ['package.json', 'apps/web/package.json', 'apps/api/package.json', 'packages/shared/package.json'];
const UNRELEASED = '## অপ্রকাশিত';

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const out = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const bump = args[0];
if (!['major', 'minor', 'patch'].includes(bump)) fail('say which part to raise: pnpm release minor | patch | major');
const checks = !args.includes('--no-checks');
const trailers = args.flatMap((a, i) => (a === '--trailer' && args[i + 1] ? ['--trailer', args[i + 1]] : []));

if (out('git', ['branch', '--show-current']) !== 'dev') fail('run it on the dev branch');
if (out('git', ['status', '--porcelain']) !== '') fail('commit or stash your changes first');
run('git', ['fetch', 'origin']);
try {
  execFileSync('git', ['merge-base', '--is-ancestor', 'origin/main', 'dev']);
} catch {
  fail('main has commits that dev does not; bring them into dev first');
}

const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
const [maj, min, pat] = current.split('.').map(Number);
const next = bump === 'major' ? `${maj + 1}.0.0` : bump === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());

const log = readFileSync('CHANGELOG.md', 'utf8');
const start = log.indexOf(`${UNRELEASED}\n`);
if (start === -1) fail(`CHANGELOG.md has no "${UNRELEASED}" section: write what changed (in Bengali) first`);
const end = log.indexOf('\n## ', start + UNRELEASED.length);
const section = log.slice(start, end === -1 ? undefined : end);
if (!/^- \S/m.test(section)) fail(`the "${UNRELEASED}" section lists no change`);
writeFileSync('CHANGELOG.md', log.replace(`${UNRELEASED}\n`, `## ${next} (${today})\n`));
for (const file of PACKAGES) {
  writeFileSync(file, readFileSync(file, 'utf8').replace(/"version": "[^"]+"/, `"version": "${next}"`));
}

if (checks) {
  run('pnpm', ['lint']);
  run('pnpm', ['typecheck']);
  run('pnpm', ['test']);
}

run('git', ['add', 'CHANGELOG.md', ...PACKAGES]);
run('git', ['commit', '-m', `release: v${next}`, ...trailers]);
run('git', ['push', 'origin', 'dev']);
run('git', ['switch', 'main']);
run('git', ['pull', '--ff-only', 'origin', 'main']);
run('git', ['merge', '--ff-only', 'dev']);
run('git', ['push', 'origin', 'main']);
run('git', ['tag', '-a', `v${next}`, '-m', `v${next}`]);
run('git', ['push', 'origin', `v${next}`]);
run('git', ['switch', 'dev']);

console.log(`\nReleased v${next}. When GitHub has built it, set TAG=v${next} in Portainer and redeploy.`);
