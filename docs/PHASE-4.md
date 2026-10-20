# Phase 4: Assets, NAV and the constitution's money obligations

Status: **built and green.** `pnpm check` equivalent: lint, types, 396 API tests (with a real database), 76 shared, 9 web, 6 e2e scenarios.

## What changed and why

### Assets can no longer be conjured by hand
Before this phase a cashier could create an asset "held" at any cost, give it a valuation and mark it sold, all without a ledger entry or a vote. That moves NAV (and therefore what new members pay to join) with nothing behind it. Now:

- `POST /assets` only notes down a `planned` asset with no money. `PATCH /assets/:id` only edits descriptive fields. Both reject cost, status, sale and valuation fields.
- The direct valuation route is gone. Valuations come from executed `valuation_update` proposals.
- Purchases come from `investment_purchase`, sales from `asset_sale`, both as proposals.

### Buying land or a house in stages
`POST /assets/:id/payments` (cashier, step-up) posts `DR INVESTMENTS_AT_COST, CR <account>` and raises what has been paid, never past the maximum the members approved. `POST /assets/:id/complete` moves it to `held` and needs a note and a document; land or a house also needs a deed and an ownership split whose shares equal every share in the fund (spec 5.11, 18.7).

### Compliance and feasibility before voting
Opening an `investment_purchase` fails with `proposal.compliance_incomplete` (naming the unticked boxes) unless every compliance box is ticked, and with `proposal.feasibility_required` when the policy asks for a feasibility file and none is attached.

### Obligations (`proposals/executors/obligations.ts`)
- **Levy** (`asset_cost_levy`): creates a `levy` due for each active member in proportion to shares (remainder to the last member). One levy per month (the due table allows one per member, period and kind). Payments with purpose `levy` (members from the Pay screen, or the cashier) credit `LEVY_CLEARING`, never capital, never NAV. `POST /levy/remittances` hands collected levy to the registrar (`DR LEVY_CLEARING`), never more than is held. `GET /levy` shows what is held.
- **Member qard** (`member_qard`): an interest-free loan from a member to the fund. Receiving posts `DR <account>, CR MEMBER_QARD` for that member; repaying is the reverse and cannot exceed what that member lent.
- **Financing arrangement**: records a deferred purchase of an asset and its instalments (which must add up to the total), books `DR INVESTMENTS_AT_COST, CR DEFERRED_PURCHASE_PAYABLE`, and each instalment is paid later with `POST /financing/instalments/:id/pay`. New tables `financing_arrangements` and `financing_instalments` are in `db/migrations/001_initial-schema.sql`.
- **Wind-up**: sets the `wind_up` setting. Dues generation then returns `skipped: 'winding_up'` and new members are refused. Assets are sold by `asset_sale` proposals and members are paid by `settlement` proposals of kind `wind_up`.

No path lends money to a member: a test checks that cash only ever leaves to a member through a settlement, escrow payout, distribution, qard repayment or donation.

### Screens
- Cashier: **Assets** (net assets and value per share, add an idea, pay an instalment, attach a document, complete an acquisition), **Rent** (streams, expected rent by month, receive), **Obligations** (levy held and remittance, deferred-purchase instalments).
- The **proposal form** now covers every type that needs one (purchase with the compliance checklist and feasibility file, sale, valuation, levy, qard, financing with instalments, wind-up, expense, donation, distribution, role change, new member, rule change, constitution amendment, and so on). Reinstatement and settlement are created from the Members screen; `fine_waiver` has no form yet (fines are waived from a proposal created through the API).
- Members: the existing assets and NAV screens; the Pay screen offers "levy" when a member has one outstanding.

## Existing dev databases
`001_initial-schema.sql` changed (two financing tables). A database that was migrated before this needs the two tables once; the SQL is the `financing_arrangements` and `financing_instalments` part of that file. Fresh databases (tests, e2e, a new install) get them automatically.

## Known gaps
- Attachments on a financing arrangement are attached to the asset instead (no separate document list for the arrangement).
- Staged payments are limited by the proposal's `max_amount_paisa`; an asset created by hand has no limit because it cannot hold money (it is `planned`).
- `fine_waiver` proposals cannot be created from the screen yet.
