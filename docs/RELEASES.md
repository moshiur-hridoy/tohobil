# Releases, versions and the changelog

Every merge of `dev` into `main` is a release with a version number, and what changed is written in
Bengali in `CHANGELOG.md`. Members read that file in the app (Menu → কী নতুন), and the first time the app
opens after an update a small card says so.

## Version numbers

`MAJOR.MINOR.PATCH`, for example `1.8.0`:

- **MINOR** (`1.7.0 → 1.8.0`): something new for members, the cashier or the auditor.
- **PATCH** (`1.8.0 → 1.8.1`): only fixes.
- **MAJOR** (`1.8.1 → 2.0.0`): a big change, such as a change to how the books work.

The version lives in the root `package.json` (the workspace packages carry the same number). The web
app shows it from the build (`__APP_VERSION__`, `vite.config.ts`); the API's `/health` shows the `TAG`
the stack runs (`APP_VERSION`).

The history before this process was numbered from the merge dates on `main`:

| Version | Date | Commit |
|---|---|---|
| 1.0.0 | 2026-10-20 | `4498f24` |
| 1.1.0 | 2026-10-21 | `90d81e9` |
| 1.2.0 | 2026-10-22 | `7842467` |
| 1.3.0 | 2026-10-30 | `4c227a3` |
| 1.4.0 | 2026-10-31 | `0be30e3` |
| 1.5.0 | 2026-11-02 | `7c287b5` |
| 1.6.0 | 2026-11-03 | `27d84da` |
| 1.7.0 | 2026-11-03 | `ab3eefc` |

Those commits carry git tags; their images exist only under the commit id.

## Writing the changelog

While working on `dev`, add the changes under `## অপ্রকাশিত` at the top of `CHANGELOG.md`:

```
## অপ্রকাশিত

### নতুন
- What a member, the cashier or the auditor can now do, in plain Bengali.

### ঠিক করা হয়েছে
- What was wrong before and now works.
```

Write for members, not developers: no code words, one line per change, only changes someone can see.
The technical detail stays in the commit messages and `docs/ASSUMPTIONS.md`.

## Releasing

On `dev`, with everything committed:

```bash
pnpm release minor     # or patch / major
```

It turns `## অপ্রকাশিত` into `## 1.8.0 (today)`, sets the version in every `package.json`, runs lint,
types and tests, commits `release: v1.8.0` on `dev`, fast-forwards `main`, and pushes the tag `v1.8.0`.
It refuses to run off `dev`, with uncommitted changes, when `main` has commits `dev` lacks, or when
`## অপ্রকাশিত` is missing or empty.

GitHub then builds the images tagged `v1.8.0`. Deploy by setting `TAG=v1.8.0` in Portainer
(`docs/DEPLOY-PORTAINER.md`, "Updating later").
