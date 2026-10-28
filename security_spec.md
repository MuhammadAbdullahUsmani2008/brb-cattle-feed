# BRB Feed Industry — Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants

1. **Default-Deny Boundary**: Any collection or document path not explicitly matched (`/admins/{adminUid}`, `/cloud_backups/{backupId}`, `/cloud_backups/{backupId}/chunks/{chunkId}`, `/audit_events/{eventId}`) is unconditionally denied (`allow read, write: if false`).
2. **Verified Identity & Anti-Spoofing**: Every authenticated read/write requires `request.auth != null` AND `request.auth.token.email_verified == true`. Unverified email claims (even matching the bootstrapped main administrator email) are rejected.
3. **Privilege Escalation Prevention**: Only the bootstrapped verified main administrator (`muhammadabdullahusmani9670@gmail.com`) can create, update, or delete `/admins/{adminUid}` role assignments. No ordinary user can self-assign an admin profile.
4. **PII Isolation**: `/admins/{adminUid}` contains administrator email addresses and is readable strictly by the profile owner (`request.auth.uid == adminUid` with verified email) or a verified admin (`isAdmin()`). Blanket `isSignedIn()` reads are forbidden.
5. **Master Gate Relational Sync**: `/cloud_backups/{backupId}/chunks/{chunkId}` requires the parent `/cloud_backups/{backupId}` document to exist AND match `authorUid == request.auth.uid`.
6. **Strict Schema & Anti-Shadow-Field Gate**: Every `create` and `update` enforces `hasAll` and `hasOnly` key allowlists, explicit type checks, regex ID patterns (`^[a-zA-Z0-9_\-]+$`), and strict `.size()` bounds synchronized verbatim with `firebase-blueprint.json`.
7. **Temporal & Immortal Field Integrity**: `createdAt` must equal `request.time` on creation and remain immutable on update; `updatedAt` must equal `request.time` on creation and update; `authorUid`, `backupId`, and `uid` are immutable once created.
8. **Terminal State Locking**: Once a `CloudBackupSnapshot` transitions to `status == 'completed'`, further non-admin mutations are locked, and even authorized transitions can only move `'uploading' -> 'completed'` with `affectedKeys().hasOnly(['status', 'updatedAt'])`.
9. **Immutable Audit Trail**: `/audit_events/{eventId}` is append-only (`allow update, delete: if false`).
10. **Zero O(n) List Lookups**: `allow list` rules evaluate `isBootstrappedMainAdmin()` or `resource.data.authorUid == request.auth.uid` directly without invoking `get()` or `exists()`.

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Payload 1 — Unauthenticated Backup Read/Write**: `auth = null` attempting `get` or `create` on `/cloud_backups/bkp_01` → `PERMISSION_DENIED`.
2. **Payload 2 — Email Spoofing Without Verification**: `auth = { uid: 'spoof1', email: 'muhammadabdullahusmani9670@gmail.com', email_verified: false }` attempting `create` on `/admins/spoof1` → `PERMISSION_DENIED`.
3. **Payload 3 — Self-Assigned Admin Escalation**: `auth = { uid: 'cust1', email: 'attacker@example.com', email_verified: true }` attempting `create` on `/admins/cust1` with `role: 'main_admin'` → `PERMISSION_DENIED`.
4. **Payload 4 — PII Blanket Scrape on `/admins`**: `auth = { uid: 'user2', email: 'user2@example.com', email_verified: true }` attempting `get` on `/admins/otherAdmin` → `PERMISSION_DENIED`.
5. **Payload 5 — Shadow Ghost Field Injection**: Valid admin creating `/cloud_backups/bkp_01` with extra key `"isSuperVerified": true` → `PERMISSION_DENIED` (`hasOnly` rejection).
6. **Payload 6 — Identity Spoofing (`authorUid` mismatch)**: Admin `uid_A` creating `/cloud_backups/bkp_01` with `authorUid: "uid_B"` → `PERMISSION_DENIED`.
7. **Payload 7 — Path Variable / ID Poisoning**: Creating `/cloud_backups/bad$id!spaces` or 200-char ID → `PERMISSION_DENIED` (`isValidId` guard).
8. **Payload 8 — Denial-of-Wallet Oversized String**: Creating `/cloud_backups/bkp_01` with a 10,000-char `notes` string (exceeding `maxLength: 500`) → `PERMISSION_DENIED`.
9. **Payload 9 — Forged Client Timestamp**: Creating `/cloud_backups/bkp_01` with past/future `createdAt != request.time` → `PERMISSION_DENIED`.
10. **Payload 10 — Orphaned Subcollection Chunk Write**: Creating `/cloud_backups/non_existent/chunks/chunk_0` when parent `/cloud_backups/non_existent` does not exist → `PERMISSION_DENIED` (Master Gate `exists`/`get` check).
11. **Payload 11 — Value Poisoning / Immortal Field Mutation on Update**: Updating `/cloud_backups/bkp_01` to mutate `sha256Checksum` or `createdAt`, or updating after `status == 'completed'` → `PERMISSION_DENIED`.
12. **Payload 12 — Audit Trail Tampering**: Authenticated main admin attempting `update` or `delete` on `/audit_events/evt_01` → `PERMISSION_DENIED`.
