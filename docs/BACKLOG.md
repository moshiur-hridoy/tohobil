# Backlog: planned, not built

Plans discussed with the owner and parked until they ask for them. Nothing here is built. Each item
lists the open decisions; the suggested answer is marked. Before building one, confirm the decisions
with the owner, then record them in `docs/ASSUMPTIONS.md`.

## 1. Responsible member per investment, value updates reviewed by the auditor

Today every value update of a shop (investment partner) is a `valuation_update` proposal that the
members vote on (Doc.md 18.3, constitution 4.2 and 12.2).

- The cashier picks a **responsible member** for each investment partner (partner terms edit; audited;
  all members notified).
- That member sees "my investments" on the Assets page and can send a **value / profit update** with
  the shop's statement attached. The shop keeps its profit, so profit is a value increase (ASSUMPTIONS 84);
  profit paid out in cash stays an ordinary cashier entry.
- The **auditor** sees old value → new value, gain or loss and the statement, and approves (step-up)
  or rejects with a reason. NAV changes only after approval; then every member is notified and can object.
- The cashier's own "update value" button takes the same path. Nobody approves their own request.
- Needs: a request table (append-only, status transitions guarded like `payments`), a new approval
  kind, `investment_partners.custodian_member_id`, a link from `asset_valuations` to the request,
  three screens (partner page, member Assets page, auditor queue), tests.

Open decisions:
1. A large change (more than 10%) still goes to a vote? **Suggested: yes, 10%.**
2. If the auditor is the responsible member, who approves? **Suggested: it goes to a vote.**
3. Statement photo required? **Suggested: required.**
4. Shops only, or the fund's own land and buildings too? **Suggested: shops only for now.**

Prerequisite: an active auditor. Check in the `db` container with
`psql -U barakah_migrator -d barakah -c "SELECT m.code, u.roles FROM users u JOIN members m ON m.id = u.member_id WHERE u.roles && '{cashier,auditor}';"`.
This overrides the share/member vote for valuations, so it is an owner decision the group should agree.

## 2. Hard and easy approval modes per decision (settings)

Members rarely open the app, so in-app votes stall. Give every proposal type a choice of approval path,
configurable in Settings, with presets so another group running this from GitHub can pick its own.

Approval paths:

| Path | Passes when | Members must |
|---|---|---|
| In-app vote (hard, today) | the vote reaches its threshold | open the app |
| Meeting / WhatsApp record | the cashier ticks who agreed and attaches the minutes or a screenshot; the auditor confirms | nothing |
| Auditor approval | the cashier enters it, the auditor approves | nothing |
| Notice | everyone is notified; no objection within N days (an objection sends it to a meeting) | object only if they disagree |

Settings → "Decision rules": presets **Hard** (all votes), **Easy** (below), **Custom**; one row per
proposal type with its path and extras (notice days, escalation percentage) and the constitution clause.

Guardrails that no setting can remove:
1. Changing these settings needs every member's agreement (meeting record + auditor), all members are
   notified, and it takes effect 7 days later.
2. A floor per type: taking money out, sales, profit distribution, dissolution and constitution changes
   are never "notice" or "auditor only"; at least meeting record + auditor.
3. Ledger immutability, reversals only, audit log, hash chain, a member's own payment notifications,
   and cashier ≠ auditor never change. A proposal copies its rules when created (as policies do now).

Suggested "Easy" preset for this fund:

| Decision | Path |
|---|---|
| Monthly dues, payments | no vote (as now) |
| Shop value / profit update | auditor; over 10% change → meeting record |
| Expense under ৳1,00,000 | auditor |
| Large expense, new investment, withdrawal or sale, profit distribution | meeting record + auditor |
| Charity donation | auditor + notice to everyone |
| Fine waiver, reinstatement, general matters | notice, 7 days |
| Suspension, settlement, cashier or auditor change | meeting record + auditor |
| New member, contribution change, constitution, dissolution, these settings | meeting record with every member + auditor |

Build in three steps: (1) auditor path (valuation from item 1, small expenses); (2) meeting record path;
(3) notice path, the Settings page with presets, and `docs/GOVERNANCE.md`.

Open decisions: the preset table above; notice length (**suggested 7 days**); every member agrees to a
settings change (**suggested yes**); SMS must work on the live server before the notice path is useful.

## 3. Member requests a correction of their own details

Today only the cashier can change a name or phone, and nobody can change the share register
(registered name per share, nominee name and relation): it is filled only by the legacy import.

- Member: Menu → "My details" lists name, phone, joining date and each share's registered name and
  nominee, each with "wrong or missing? request a correction" (new value, optional note and photo such
  as an NID), plus an "other" box. The member sees each request's status and the reason if declined.
- Cashier: notification and a "correction requests" item in today's tasks; sees old → requested value;
  approves (applied at once, audited) or declines with a reason; the member is notified.
- Rules: a nominee changes **only on the member's own request** (the nominee receives the money on
  death); if the cashier files it for a member who told them in person, the auditor must approve.
  Phone changes need the cashier's approval (SMS matching uses the number). Joining date and share
  counts are not changed through this form. Old values are kept in the request row and the audit log.

Open decisions: the field list (name, phone, registered name per share, nominee name and relation,
"other"); nominee only on the member's request (**suggested yes**); photo optional (**suggested optional**).

## 4. More shares for an existing member, and share register lines for new shares

A member who adds a share stays the same member (M01: 2 → 3 shares, dues per share go up) and the share
register gets a new line (next share number) with its own registered name and nominee.

Gaps found in the code:
1. There is no flow to add shares to an existing member (`share_holdings.source` has an unused
   `transfer_in`).
2. A new member's entry inserts `share_holdings` but no `share_register` lines, so their shares have no
   registered name or nominee.
3. Offering a leaving member's share to current members first (Doc.md 1083, constitution 5.3) is not built.

Open decisions:
1. Price: **suggested today's NAV per share**, as for a new member, so others are not diluted.
2. Approval: unanimous like a new member, or a majority? **Suggested majority** (not a new person).
3. Source: newly issued shares, a leaving member's share offered first, or both? **Suggested both**,
   leaving member's share first.

## Smaller items

- Privacy mode: the dashboard collection chart still shows bar heights; blur them too.
- `pnpm audit --audit-level=high` fails on a zod advisory (GHSA-mrhx-c7xc-m3w5) through
  `fastify-type-provider-zod` and the API's zod 3; needs the zod 4 upgrade.
- No screen shows the audit log yet (role changes from `set-role` are only in the database).
