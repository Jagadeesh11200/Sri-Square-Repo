# Sri Square feature map

## Roles and entry

| Area | What it does | Guardrails |
| --- | --- | --- |
| Direct workspace | The owner workspace opens immediately, with no login or logout screen. | Every immutable event is attributed to the fixed Sri Square Owner audit identity. |
| Access scope | This is a private owner tool for the Guntur, Andhra Pradesh hall; customers never sign in or interact with it. | Keep production behind a trusted reverse proxy, VPN or private network because anyone who can reach it can operate it. |

## Hall booking lifecycle

| Step | Behaviour | Edge cases covered |
| --- | --- | --- |
| Create booking | Captures customer, serial number, two advances, and an exact local start/end schedule with an IANA time zone. | Serial numbers are unique; dates, currency values and payment modes are validated. |
| Check availability | Tests the proposed interval against every active booking. | Converted to UTC before comparison, so simultaneous times in different zones conflict correctly. Exact end-to-start adjacency is allowed. |
| Revise booking | Adds a new booking event rather than altering the old record. | The proposed new interval is checked again server-side, excluding only its own earlier interval. |
| Modify booking | Saves an additive booking revision, then recalculates every current financial/dashboard/document projection. | The proposed interval is checked again server-side, excluding only its own earlier interval. |
| Archive / delete booking | Records an archive reason and retains the complete history. | Archived bookings cannot be edited, billed or financed and no longer occupy the hall. Existing receipts remain actual cash history; refunds are explicit compensating entries. |
| Restore booking | Reinstates an archived booking as another immutable event. | Restore is rejected if any active booking has taken the original exact interval. |
| Calendar | Shows every calendar date an active booking occupies, including an overnight booking’s end date. | Calendar is an overview; the final decision always uses exact times and time zones. |
| DST | Converts local clocks without guessing. | Nonexistent spring-forward times and ambiguous fall-back times are rejected for a clear replacement time. A booking is at least 30 minutes and at most 24 hours. |

## Customer billing and internal finance

| Area | Calculation / behaviour |
| --- | --- |
| Customer bill | Hall rent + water + (`power units × ₹18`) + other charges. Cleared advances and a cleared final payment reduce the due amount; overpayment is shown as customer credit. |
| Internal finance | Hall rent + water + power + decoration commission + lighting commission + only charges flagged as Finance Income. Expenses and non-cash advances reduce event balance. |
| Commissions | Decoration and lighting commissions default to 30% from vendor totals, while remaining editable. |
| Expenses | Each expense has an amount, paid date and payment mode. Saving adds a finance revision. |
| Documents | Booking confirmation, customer bill and internal financial report are branded, print-ready and shareable locally. |

## Cash, dashboard and audit

| Area | Behaviour |
| --- | --- |
| Automatic cash | Cash-mode advances, cleared cash final payments and cash-mode expenses generate their own append-only cash movements when the related revision is saved. The booking revision and every resulting cash movement are committed together in one SQLite transaction. Amount changes produce compensating deltas; date/reference changes produce an immutable reversal and replacement rather than overwriting old cash records. |
| Manual cash | External cash can be added separately. Corrections reference an original cash entry and are compensating credits/debits. |
| Dashboard | Reprojects active bookings and the cash ledger after every refresh: counts, upcoming events, customer bill value, due/credit/received amounts, internal balance, cash balance, debits and cancelled count. Archiving immediately removes a booking from live booking/finance totals but deliberately leaves real money in the cash ledger; any customer refund is a separate, traceable debit adjustment. |
| Audit | Booking events, automatic cash movements, manual cash, availability checks, report views and backups are timestamped immutable events under the fixed owner identity. |
| Backups | Exports the event log; import only adds unseen event IDs. Original Sri Square PWA backups are migrated once and never overwrite current data. |

## Verification included

`npm test` checks direct workspace access, append-only booking/billing/finance/cash/backup flows, correction propagation, automatic dashboard totals, time-zone collision handling, adjacent slots, archive/restore capacity rules, cancellation accounting, DST rejection, Guntur-date defaults and legacy backup idempotency.
