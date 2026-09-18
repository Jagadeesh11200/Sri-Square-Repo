# Sri Square Operations

Sri Square Operations is a private, owner-operated function-hall assistant for **Guntur, Andhra Pradesh (IST / `Asia/Kolkata`)**. It opens directly to the workspace—there is no login, logout, customer portal, or multi-user access. It covers time-zone-safe booking and availability, customer billing, internal finance, integrated cash, reporting, backup, and audit history. See [FEATURES.md](FEATURES.md) for the complete feature and edge-case map.

## Start locally

```powershell
npm install
npm start
```

Open [http://localhost:3030](http://localhost:3030).

For development with automatic server restart:

```powershell
npm run dev
```

Run the end-to-end verification suite:

```powershell
npm test
```

## Deployment

The app is server-backed and persists a SQLite database, so it is deployed as a Docker service rather than to GitHub Pages. GitHub Actions validates every pull request and, on every successful `main` push, publishes an immutable image and automatically rolls it out to a configured persistent Docker host.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the one-time repository secrets, host setup, and the full release flow.

## Direct owner workspace

The application has no sign-in screen or logout control. It always attributes its append-only events to the fixed **Sri Square Owner** identity for audit clarity. Since everyone who can reach it can operate the hall records, production must remain private: the supplied Docker deployment only binds the service to `127.0.0.1`; expose it only through a trusted reverse proxy, VPN, or private network.

## Data and audit model

- The local SQLite database is created at `data/sri-square.db`.
- Business changes are append-only events in `domain_events`; there are no delete endpoints.
- Booking changes, customer-billing saves, financial saves, cash entries, cash corrections, backups, reports and screen views are time-stamped.
- Owner corrections cascade through the latest booking projection, calendar availability, customer balance, internal finance, documents and dashboard. Old records are retained as immutable revisions.
- Cash corrections are compensating entries, never edits or deletions.
- Backup import only appends event IDs that do not already exist; it never replaces local data.
- The legacy `SRI SQUARE ACCOUNTS BACKUP` JSON files from the original static PWA are recognized and migrated once into this event store.
- Scheduled backups are generated as JSON in `data/backups/` when the local server is running at the configured time.

The UI projects the latest booking state from its event history while retaining the full prior history in the audit screen.

## Financial rules preserved from the original product

- Customer bill = hall rent + water + (`power units × ₹18`) + all other charges.
- Amount received = two advances + final payment only when marked cleared.
- Internal financial total = hall rent + water + power + decoration commission + lighting commission + only other charges marked **Finance Income**.
- Decoration and lighting commission default to 30% of their respective vendor totals.
- Event balance = financial total − expenses − UPI/Company Account advances.
- Cash-mode advances, cleared cash final payments and cash-mode expenses automatically post append-only cash movements. External/manual cash remains available as a separate entry type.
- When a booking or finance revision changes a prior cash amount, the system appends only the difference; it never overwrites the original cash movement.
- When a cash receipt or expense date/reference changes, the ledger records an immutable reversal at the old detail and a replacement at the new one—never a silent edit.

## Scheduling and availability safeguards

- Every new booking records a local start, local end and IANA time zone. The server normalizes the interval to UTC and checks it again when the booking is saved.
- Any overlap with an active booking is rejected even if the two bookings use different local time zones. Back-to-back intervals are allowed.
- DST gap and duplicate local-clock times are rejected rather than being guessed. Booking length is limited to 30 minutes through 24 hours.
- Archive/delete is additive: it records a reason, preserves all financial/audit records, removes the booking from live totals, and makes the slot available again. An owner can restore it only if its original exact slot remains free.

## GitHub delivery

This folder is a Git repository on the `main` branch. Commit and push it to a GitHub repository, then configure the production secrets listed in [DEPLOYMENT.md](DEPLOYMENT.md). Every push to `main` runs checks, publishes an immutable Docker image, and deploys it automatically to the configured persistent Docker host. Pull requests receive validation before merge.

## Structure

```text
server/database.js   SQLite schema, seed accounts, immutable event store
server/domain.js     Booking/cash projections and calculation rules
server/index.js      Express API, direct owner workspace, backups and audit endpoints
public/              Responsive frontend, design system and offline shell
test/                Isolated end-to-end test using a temporary local database
```
