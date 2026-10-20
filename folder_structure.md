# Folder structure (Phase 0, as built)

```
barakah/
├── Doc.md                       authoritative build specification
├── CLAUDE.md                    commands, rules, link to the spec
├── package.json                 workspace scripts, pnpm settings (audit config, overrides)
├── pnpm-workspace.yaml · pnpm-lock.yaml · tsconfig.base.json
├── .eslintrc.cjs · .prettierrc · .prettierignore · .gitignore · .dockerignore · .env.example
│
├── apps/
│   ├── api/                     Fastify API
│   │   ├── build.mjs            esbuild bundle -> dist/{index,migrate,healthcheck}.js
│   │   ├── vitest.config.ts
│   │   └── src/
│   │       ├── index.ts · app.ts · migrate.ts · healthcheck.ts
│   │       ├── lib/             env, db (pool + type parsers), errors, error-handler, logger, ledger-chain
│   │       ├── routes/          health
│   │       ├── db/              schema.test.ts (real-Postgres tests)
│   │       ├── test/            db-harness.ts
│   │       ├── services/        (Phase 1+)
│   │       └── jobs/            (Phase 2+)
│   └── web/                     React PWA + Capacitor
│       ├── index.html · vite.config.ts · tailwind.config.ts · postcss.config.js · capacitor.config.ts
│       ├── public/              icons/, favicon.ico, apple-touch-icon.png, offline.html
│       ├── scripts/             generate-placeholder-icons.mjs, android-release.mjs
│       └── src/
│           ├── main.tsx · App.tsx
│           ├── components/      UpdatePrompt
│           ├── layouts/         MemberLayout, CashierLayout
│           ├── lib/             i18n, format, api-cache-matcher
│           ├── pages/           auth/, member/, admin/, NotFoundPage
│           └── styles/          theme.css (all design tokens), globals.css
│
├── packages/shared/             zod schemas, money, dates, enums, i18n (consumed as TypeScript source)
│   └── src/ money.ts · date.ts · enums.ts · schemas/ · i18n/{bn,en}.json
│
├── db/
│   ├── migrations/001_initial-schema.sql     schema, triggers, views, seeds, grants
│   └── seed/run.ts                           fictional fixture (local databases only)
├── scripts/verify-ledger.ts
│   └── import-sheet/            (Phase 1)
├── infra/
│   ├── docker-compose.yml · docker-compose.dev.yml · Dockerfile.api
│   └── initdb/10-roles.sh       creates barakah_app and barakah_readonly
├── docs/                        ARCHITECTURE, ASSUMPTIONS, AUDIT-PHASE-0, PHASE-0, RUNBOOK, RECOVERY-KIT, GO-LIVE, ANDROID
├── examples/constitution.example.md
├── design/                      reference UI (not yet supplied)
└── private/                     git-ignored group documents (.gitkeep only)
```
