# UI demo (for the case study)

A public, click-around copy of the app that needs **no server and no database**. Visitors pick
Cashier (M01), Auditor (M07) or Member (M02) on the sign-in screen and see every screen filled with
data from a made-up fund. Anything that would change the books answers "This is a demo: changes are
not saved", so the demo can never hold real money or real people.

## How it works

- `pnpm demo:record` builds the throwaway e2e database, fills it with ten months of fictional
  history (payments with a few members behind, one payment waiting for the cashier, proposals open,
  approved, rejected and carried out, two planned assets, a partner shop, the next meeting), then
  opens every screen as each role and saves what the screen received to
  `apps/web/src/demo/data/<role>.json`.
- `pnpm demo:build` builds the web app with `VITE_DEMO=1`. In that build `apps/web/src/lib/api.ts`
  answers from those files (`apps/web/src/demo/mock.ts`) instead of calling `/api`.
- The normal build drops the demo branch entirely: no demo code or data ships to the real fund.

## Publish it (about 5 minutes, free)

1. `pnpm demo:build` (the site lands in `apps/web/dist`, with a `_redirects` file so deep links work).
2. Go to <https://app.netlify.com/drop>, sign in, and drag the `apps/web/dist` folder onto the page.
3. Netlify gives you a link such as `https://barakah-demo.netlify.app`. Put that in the case study.

To update it later, run `pnpm demo:build` again and drag the new `dist` folder onto the same site
(Netlify: Site → Deploys → drag and drop). Cloudflare Pages works the same way and reads the same
`_redirects` file.

## Refresh the sample data

Only needed after screens change what they load. Needs Docker running (it uses the local Postgres):

```bash
docker compose -f infra/docker-compose.dev.yml up -d db
pnpm demo:record     # about 3 minutes; rewrites apps/web/src/demo/data/*.json
pnpm demo:build
```

A screen whose data was not recorded shows "This part has no sample data in the demo"; recording
again fixes it.
