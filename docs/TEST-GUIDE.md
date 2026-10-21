# Testing guide (for the owner)

Written for someone who is not a developer. Follow it top to bottom, tick the boxes, and write down anything that surprises you. Nothing here touches real money: the data is fictional and lives only on your computer.

## 1. Start the app

Open the Terminal in the project folder, then run these one at a time:

```
docker compose -f infra/docker-compose.dev.yml up -d db     # starts the database
pnpm migrate                                                 # prepares the database (safe to repeat)
pnpm seed                                                    # 8 pretend members (safe to repeat)
pnpm dev                                                     # starts the app
```

Open **http://localhost:5173** in Chrome. To try it on a phone on the same Wi-Fi, open `http://<your Mac's address>:5173` instead (the terminal shows the address as "Network").

To start again from nothing: stop `pnpm dev` (Ctrl+C), run `docker compose -f infra/docker-compose.dev.yml down -v`, then repeat the four commands above.

## 2. Who is who

| Member | Role | Shares |
| --- | --- | --- |
| M01 | **Cashier** (you, for testing) | 2 |
| M07 | **Auditor** | 4 |
| M02, M03, M04, M05, M06, M08 | Ordinary members | 4, 1, 1, 3, 1, 4 |

The cashier and the auditor are always different people. Many actions need **both**: the cashier prepares, the auditor approves. Use two different browsers (for example Chrome and a private window, or Chrome and Safari) to be both at once.

## 3. Get everyone able to sign in

1. **Make the first login (M01).** In the Terminal: `pnpm activation-code M01 --code=12345678`. In the browser open `/activate`, enter `M01` and `12345678`, then choose your own 6-digit PIN twice. Use an easy-to-remember PIN that is not `123456` or `000000`.
2. **Set up the authenticator (M01).** Cashier and auditor actions that move money or approve things ask for a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy). Open **Menu → Authenticator** (`/totp`), press the start button, scan the code (or type the secret into the app), then enter the 6 digits it shows. You only do this once per device; the code is then asked for again every 12 hours.
3. **Give the others a PIN.** As M01 go to **Admin → Members** and press **Issue PIN** next to each member. A 6-digit PIN appears **once**; write it down. Do this for M07 and for the members you want to test with. They sign in at `/login` with their member ID (for example `M02`) and that PIN, and can change it under **Menu → Change PIN**.
4. **Auditor.** Sign in as `M07` in the second browser and set up the authenticator the same way.

If you forget a PIN: as M01, press **Issue PIN** again. (If you forget M01's own PIN: `pnpm set-pin M01` is not available; use `pnpm activation-code M01 --code=12345678` and activate again.)

## 4. What to try, screen by screen

Tick each line when it behaves as described. "Cashier" means signed in as M01, "Auditor" as M07, "Member" as M02 or similar.

### Paying and confirming money (Phase 1)
- [x] **Member:** Pay → press "I have sent money", enter an amount, bKash, a TrxID like `ABC123`, today's date, send. It shows as *under verification*.
- [x] **Cashier:** Admin → Payments shows it. Open it, check the amount, **Confirm** (asks for the authenticator code the first time). It becomes *confirmed*.
- [ ] **Member:** the payment is now confirmed and the month's due is paid (or part-paid).
- [ ] **Cashier:** try the same TrxID again as another member: it is refused (duplicate).
- [x] **Cashier:** Admin → Matrix shows every member's month at a glance; **export CSV** downloads a file.
- [x] **Member:** Menu → Ledger lists every entry. Press "Object" on one; **Auditor** sees it under objections and can resolve it.

### Fines and reminders (Phase 2)
- [x] **Cashier:** Admin → Notifications: lists who cannot be reached by push, with a "Send reminder" button (once per 6 hours per member), and the log of what was sent.
- [x] **Member:** Menu → Notices shows messages sent to you (a confirmed payment creates one).

### Votes and decisions (Phase 3)
- [x] **Cashier:** Admin → Proposals → New proposal. Choose "General", write a decision, submit. Open it for voting (closing time at least 1 hour away).
- [x] **Members:** Votes → open the proposal → Yes / No / Abstain. You can change your vote until it closes.
- [x] **Cashier:** when enough members agree, "Close early", then **Execute**. Status becomes *executed*.

- [ ] **Constitution:** Menu → Constitution shows the current version, clause search, and "I have read it". (A version only appears after a `constitution_amendment` proposal is executed with a PDF.)

- [ not need now ] **Suspension:** Admin → Members → "Create suspension" for a member, vote, execute. That member can still sign in but cannot pay or vote (read-only).

### Assets, rent and levies (Phase 4)
- [ ] **Cashier:** Admin → Proposals → New → "Investment purchase" (for example gold). Tick every compliance box, attach any PDF as the feasibility file, set a maximum amount. Try opening it with one box unticked: it is refused. Tick all, vote, execute with the real cost: the asset appears under **Admin → Assets** and the cash goes down.
- [ ] **Cashier:** Admin → Proposals → "Valuation update" for that asset, vote, execute: the **value per share** on the Assets screen changes.
- [not need now ] **Land in stages:** purchase "Land": it shows *Being acquired*. Use **Pay instalment**, **Attach document** (type "Deed") and **Complete**. It is refused until the deed is attached and the ownership split covers every share.
- [ not need now] **Rent:** Admin → Rent: add a rent stream, press "Generate this month", then **Receive rent**.
- [ not need now] **Levy:** propose "Levy (asset cost)", vote, execute. Each member gets a levy due. A member pays it from **Pay** (choose "Levy"). Admin → Obligations shows the money held for the registrar; **Hand to the registrar** pays it out. The fund's value per share does not change.

### Month end, reports and safety (Phase 5)
- [ ] **Cashier:** Admin → Reconcile: pick last month, type what is really in each of the four accounts, submit. A wrong number needs a note.
- [ ] **Auditor:** Reconcile → **Approve**, then **Lock month**. Then, as the cashier, try to confirm a payment dated in that month: it is refused.
- [ ] **Any member:** Menu → My statements: **Statement (PDF)** and **Zakat information (PDF)** download. Open them: Bengali text should look correct.
- [ ] **Cashier:** Admin → Reports: download the ledger as CSV; open it in a spreadsheet.
- [ ] **Cashier or Auditor:** Admin → System: shows the backup and restore-test status ("No data" until the backup service runs), and **Check now** verifies the whole ledger ("Intact").

### Phones, dark mode and big text (Phase 6)
- [ ] On a phone (or Chrome's mobile view), switch the phone to **dark mode**: everything is readable.
- [ ] Set the phone's **font size to the largest**: nothing runs off the screen sideways.

## 5. Checking that the backups really work

This needs only Docker and takes about a minute:

```
pnpm backup:smoke
```

It must end with `BACKUP SMOKE TEST PASSED`. It proves a backup can be restored and that a tampered ledger is noticed.

## 6. If something looks wrong

Write down: which screen, what you pressed, what you expected, what happened, and the **reference code** shown in the red message (it looks like a long code after "Reference"). With those four things any problem can be found quickly.

For a full automatic check of everything the developers rely on, run `pnpm check` (about two minutes).
