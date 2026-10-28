# BRB Feed Industry — Architecture, Operations & Handover Guide

**Application Name:** `BRB Feed Industry`  
**Customer Portal Banner:** `BRB CATTLE FEEDS & OIL MILLS`  
**Official Invoice & Admin Heading:** `BRB Cattle Feed & Oil Mills`

---

## 1. System Architecture Overview

BRB Feed Industry is a full-stack, single-origin TypeScript web application enforcing strict authentication, authorization, and accounting boundaries between two separate portals:

- **Customer Application (`/`)**: Mobile-first & desktop-responsive portal for verified BRB customers (`BRB-C-ID131`+) to browse `BRB Cattle Feed` and `BRB Oil Mill` products **without product prices ever being exposed**, submit multi-category orders via a mandatory review step, compare requested vs. approved quantities (with mandatory reduction reasons and `Added by BRB` items), cancel eligible orders (`Order Received` / `Under Review`), view their **latest 12 months** of reconciled ledger transactions, download/print official BRB invoices, and receive Urdu/English notifications.
- **Administrative Application (`/admin`)**: Separate authentication, controlled one-time Main Administrator setup wizard, least-privilege Role-Based Access Control (RBAC), customer account provisioning & registration approvals, instant account blocking, product catalog management, order quantity approval, Method A (order-based) & Method B (independent offline) invoicing with server-side PDF generation (`pdfkit`), payment receipts (`ADD PAYMENT`), full multi-year Master Ledger, Part 2 Decisions Register (`DEC-5.1`–`DEC-5.8`), immutable audit logs, and SHA-256 / AES-256-GCM + Google Cloud Firestore off-host backups.

```
[ Browser: Customer Portal (/) ]          [ Browser: Admin Console (/admin) ]
   Token: brb_customer_auth_token_v1         Token: brb_admin_auth_token_v1
                 \                                     /
                  v                                   v
        +-------------------------------------------------------+
        | Express API Server (server.ts) — Port 3000            |
        | - Separate requireCustomer / requireAdmin middlewares |
        | - Instant blocked-account & RBAC permission checks    |
        +-------------------------------------------------------+
                  |                       |                   |
                  v                       v                   v
        [ BrbEngine + SQLite WAL ]  [ PDFKit Engine ]  [ SMS Gateway ]
        (ACID Financial Ledger,     (Official Page-1    (HTTPS Provider
         Integer Paisa Math)         BRB Invoice PDF)    or Honest Status)
                                                              |
                                     [ Google Cloud Firestore Backup Vault ]
                                     (Chunked SHA-256 Verified Snapshots)
```

---

## 2. Technology Stack

- **Frontend:** React 19, TypeScript, Tailwind CSS v4 (`@tailwindcss/vite`), Lucide Icons, `Plus Jakarta Sans` + `JetBrains Mono` (`tabular-nums`) + `Noto Sans Arabic` (Urdu RTL).
- **Backend:** Node.js, Express 4 (`server.ts`), `tsx` runtime.
- **Primary Transactional Database:** `better-sqlite3` running in `WAL` mode with `foreign_keys = ON` and `BEGIN IMMEDIATE` atomic financial transactions (`data/brb_feed_industry.sqlite`).
- **Cloud Backup & Security Rules:** Firebase Authentication (Google Sign-In) + Cloud Firestore Enterprise (`cloud_backups/{backupId}/chunks/{chunkId}`, `audit_events/{eventId}`), hardened with Zero-Trust `firestore.rules` and ESLint `@firebase/eslint-plugin-security-rules`.
- **PDF Engine:** Server-side `pdfkit` (`src/server/pdf.ts`) + `@media print` screen invoice sheet (`src/components/InvoiceDocument.tsx`).
- **Cryptography:** Node `crypto.scryptSync` password hashing, HMAC-SHA256 OTP digests, SHA-256 token hashing, SHA-256 snapshot integrity verification, and AES-256-GCM backup payload encryption.

---

## 3. Database Schema & Entity Relationships

Defined in `src/server/db.ts` (`CURRENT_SCHEMA_VERSION = 1`):

1. `schema_migrations` — Tracks applied SQL migrations.
2. `system_sequences` — Atomic counters (`customer_account` starting `131`, `order_number` starting `1001`, `invoice_number` starting `5001`, `payment_number` starting `1001`).
3. `system_settings` — Branding, WhatsApp contact, sequence configs, OTP rate limits, and write-only SMS gateway settings (`is_secret = 1` never returned to client).
4. `admin_users` — Separate staff credentials, `role` (`main_admin`, `customer_staff`, `order_staff`, `finance_staff`, `report_viewer`), `permissions_json`, `two_factor_enabled`, `is_active`.
5. `customers` — `sequence_number`, `account_number` (`BRB-C-ID131`+), `mobile_number`, `password_hash`, `status` (`unregistered`, `pending_otp`, `pending_approval`, `active`, `rejected`, `blocked`), `outstanding_balance_paisa`.
6. `auth_sessions` — Hashed bearer tokens (`actor_type IN ('customer', 'admin')`), expiry, revocation timestamp.
7. `otp_challenges` — Purpose-scoped HMAC-SHA256 OTP digests, expiry, max attempts, resend cooldowns, SMS status.
8. `products` — `BRB Cattle Feed` / `BRB Oil Mill`, `packing_weight`, `usage` (`Milk`, `Meat`, `Both`), `image_data_url`, `is_active`, `is_archived` (zero price columns on customer views).
9. `orders`, `order_requested_items`, `order_approved_items`, `order_status_history` — Preserves immutable customer requested quantities alongside administrator approved quantities, mandatory `reduction_reason`, `is_added_by_brb`, and full 7-stage status history.
10. `invoices`, `invoice_items`, `invoice_revisions` — `source_order_id UNIQUE` (prevents duplicate invoices per order), branding snapshot, integer paisa rates/totals, and revision history.
11. `payments`, `payment_revisions` — `Cash`, `Bank Transfer`, `Cheque`, `Online Payment`, `Other`, integer paisa credits, and revision history.
12. `ledger_entries` — Double-checked Debit/Credit rows (`invoice`, `payment`, `opening_balance`, `adjustment`) reconciling 100% with `customers.outstanding_balance_paisa`.
13. `notifications` — Customer notifications with deep-link `target_type` / `target_id` and separate `app_delivery_status` + `sms_delivery_status`.
14. `decision_register` — Interactive Part 2 Unresolved Decisions (`DEC-5.1`–`DEC-5.8`).
15. `audit_logs` & `backup_records` — Immutable security/financial audit trail and backup manifest log.

---

## 4. Environment Variable Reference (`.env.example`)

| Variable | Purpose |
| :--- | :--- |
| `PORT` | HTTP server port (defaults to `3000`). |
| `BRB_DB_PATH` | SQLite database file path (defaults to `data/brb_feed_industry.sqlite`). |
| `OTP_HMAC_SECRET` | Server-side secret key for HMAC-SHA256 OTP hashing. |
| `BACKUP_ENCRYPTION_SECRET` | Optional server-side default passphrase for AES-256-GCM backup encryption. |
| `SMS_PROVIDER_URL` | Optional HTTPS endpoint for live SMS delivery. |
| `SMS_PROVIDER_API_KEY` | Write-only secret API key for the SMS gateway. |
| `SMS_SENDER_ID` | Approved SMS sender mask (e.g., `BRB-FEED`). |
| `ALLOW_DEV_OTP_DISPLAY` | Set to `true` only in isolated local/test sandbox when SMS is unconfigured; never enable in production. |

---

## 5. Local Development Setup

```bash
npm install
npm run dev
```
- Customer Portal: `http://localhost:3000/`
- Administrative Console: `http://localhost:3000/admin`

---

## 6. Database Migration & Seeding Instructions

Migrations execute automatically on boot inside `openBrbDatabase()` (`src/server/db.ts`), seeding only system sequences (`131`, `1001`, `5001`) and the Part 2 Decisions Register (`DEC-5.1`–`DEC-5.8`). No fake customers, fake products, or default public admin passwords are created.

---

## 7. Initial Main Administrator Setup

1. Navigate to `/admin` on first launch (when `admin_users` count is `0`).
2. Complete the **Initial Main Administrator Setup** form (username, email, display name, strong password, starting customer ID sequence `131`, starting invoice sequence `5001`).
3. Once created, `/api/admin/auth/bootstrap` permanently locks (`403 BOOTSTRAP_LOCKED`).

---

## 8. SMS / OTP Provider Configuration

Configure via **Admin Console → Operations & System → Settings & Branding** (or environment variables). When no live SMS gateway is configured, notifications honestly record `sms_delivery_status = 'not_configured'` while persisting immediately in the customer's In-App Notification Center.

---

## 9. Official Logo & PDF Invoice Branding

Upload or replace the official BRB logo PNG/JPEG in **Admin Console → Operations & System → Settings & Branding**. Until uploaded, the UI and PDF renderer display a clearly labeled `Temporary Logo Placeholder`. Every invoice Page 1 strictly renders:
1. Top yellow accent line
2. BRB Logo immediately below
3. Large title `BRB Cattle Feed & Oil Mills`
Followed by invoice metadata, line items, repeated table headers on multi-page breaks, and grand total.

---

## 10. Backup, Verification & Restoration Runbook

1. Open **Admin Console → Operations & System → Backup & Cloud Vault**.
2. Click **Export & Download Backup JSON** (optionally supplying an AES-256-GCM passphrase) or **Sync Snapshot to Cloud Vault** after signing in with the authorized administrator Google account.
3. Before restoring, load the `.json` file and click **Dry-Run Verify Integrity** to validate the SHA-256 checksum and schema version.
4. Click **Restore & Overwrite DB** and confirm explicit overwrite to atomically restore all 18 tables, run `PRAGMA foreign_key_check`, and reconcile all customer balances.

---

## 11. Production Deployment Checklist

```bash
npm run build
NODE_ENV=production npm start
```
- Ensure `ALLOW_DEV_OTP_DISPLAY` is unset or `false`.
- Set strong `OTP_HMAC_SECRET` and `BACKUP_ENCRYPTION_SECRET` secrets.
- Persist the `data/` directory on durable storage and schedule regular Cloud Vault backups.
- Review and harden `firestore.rules` in Firebase Console before broad public sharing.

---

## 12. Automated Test Suite

```bash
npx --yes tsx --test firestore.rules.test.ts src/shared/domain.test.ts src/server/engine.test.ts
```
Covers Firestore Dirty-Dozen security payloads, decimal-safe paisa math, 12-month ledger cutoff logic, customer registration/OTP/approval, blocked-account Urdu enforcement, order quantity reduction validation, invoice/payment ledger reconciliation, and tampered-backup rejection.

---

## 13. Unresolved Business Decisions & Known Limitations

Tracked interactively inside **Operations & System → Decisions Register** (`DEC-5.1` through `DEC-5.8`), including live SMS provider contract (`DEC-5.5`), official high-resolution logo file (`DEC-5.4`), WhatsApp support number (`DEC-5.4`), and tax/discount policy (`DEC-5.2`, `DEC-5.8`).

---

## 14. Troubleshooting

- **Customer cannot register:** Confirm the administrator first created the `BRB-C-ID###` record with the matching mobile number in **Customers**.
- **Customer sees Urdu blocked message:** An administrator blocked the account; unblock via **Admin → Customers** to restore access (customer must sign in again as prior sessions were revoked).
- **SMS shows `SMS Not Configured`:** Provide a valid HTTPS endpoint and write-only API key in **Settings & Branding** and enable Live SMS Dispatch.
