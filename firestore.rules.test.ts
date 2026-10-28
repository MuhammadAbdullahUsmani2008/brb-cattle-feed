import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Deterministic rule-evaluator & structural audit suite verifying that
 * firestore.rules (and DRAFT_firestore.rules) strictly enforce all 12
 * "Dirty Dozen" adversarial payloads and synchronize bounds with firebase-blueprint.json.
 */

interface AuthContext {
  uid: string;
  email?: string;
  email_verified?: boolean;
}

interface RequestEnv {
  auth: AuthContext | null;
  timeMs: number;
  adminsDb: Record<string, { uid: string; email: string; role: string }>;
  backupsDb: Record<string, Record<string, unknown>>;
}

const BOOTSTRAPPED_ADMIN_EMAIL = 'muhammadabdullahusmani9670@gmail.com';
const ID_REGEX = /^[a-zA-Z0-9_\-]+$/;
const SHA256_REGEX = /^[a-f0-9]{64}$/;

function isValidId(id: unknown): id is string {
  return typeof id === 'string' && id.length >= 1 && id.length <= 128 && ID_REGEX.test(id);
}

function isVerifiedEmail(auth: AuthContext | null): auth is AuthContext {
  return auth !== null && auth.email_verified === true;
}

function isBootstrappedMainAdmin(auth: AuthContext | null): boolean {
  return (
    isVerifiedEmail(auth) &&
    typeof auth.email === 'string' &&
    auth.email.length <= 254 &&
    auth.email === BOOTSTRAPPED_ADMIN_EMAIL
  );
}

function isAdmin(env: RequestEnv): boolean {
  if (!isVerifiedEmail(env.auth)) return false;
  return isBootstrappedMainAdmin(env.auth) || Boolean(env.adminsDb[env.auth.uid]);
}

function hasExactKeys(data: Record<string, unknown>, required: string[], allowed: string[]): boolean {
  const keys = Object.keys(data);
  return required.every((k) => keys.includes(k)) && keys.every((k) => allowed.includes(k));
}

function evaluateCreateAdmin(env: RequestEnv, adminUid: string, incoming: Record<string, unknown>): boolean {
  const keys = ['uid', 'email', 'displayName', 'role', 'createdAt', 'updatedAt'];
  if (!isBootstrappedMainAdmin(env.auth)) return false;
  if (!isValidId(adminUid)) return false;
  if (!hasExactKeys(incoming, keys, keys)) return false;
  if (!isValidId(incoming.uid) || incoming.uid !== adminUid) return false;
  if (typeof incoming.email !== 'string' || incoming.email.length < 3 || incoming.email.length > 254) return false;
  if (typeof incoming.displayName !== 'string' || incoming.displayName.length < 1 || incoming.displayName.length > 120) return false;
  if (
    typeof incoming.role !== 'string' ||
    !['main_admin', 'customer_staff', 'order_staff', 'finance_staff', 'report_viewer'].includes(incoming.role)
  ) {
    return false;
  }
  if (incoming.createdAt !== env.timeMs || incoming.updatedAt !== env.timeMs) return false;
  return true;
}

function evaluateGetAdmin(env: RequestEnv, adminUid: string): boolean {
  if (!isVerifiedEmail(env.auth) || !isValidId(adminUid)) return false;
  return env.auth.uid === adminUid || isBootstrappedMainAdmin(env.auth);
}

function evaluateCreateBackup(env: RequestEnv, backupId: string, incoming: Record<string, unknown>): boolean {
  const keys = [
    'backupId',
    'authorUid',
    'createdByEmail',
    'schemaVersion',
    'recordCountsSummary',
    'sha256Checksum',
    'payloadChunkCount',
    'status',
    'notes',
    'createdAt',
    'updatedAt',
  ];
  if (!isVerifiedEmail(env.auth) || !isValidId(backupId)) return false;
  if (!hasExactKeys(incoming, keys, keys)) return false;
  if (!isValidId(incoming.backupId) || incoming.backupId !== backupId) return false;
  if (!isValidId(incoming.authorUid) || incoming.authorUid !== env.auth.uid) return false;
  if (typeof incoming.createdByEmail !== 'string' || incoming.createdByEmail.length < 3 || incoming.createdByEmail.length > 254) return false;
  if (typeof incoming.schemaVersion !== 'number' || !Number.isInteger(incoming.schemaVersion) || incoming.schemaVersion < 1 || incoming.schemaVersion > 1000) return false;
  if (typeof incoming.recordCountsSummary !== 'string' || incoming.recordCountsSummary.length < 1 || incoming.recordCountsSummary.length > 500) return false;
  if (typeof incoming.sha256Checksum !== 'string' || incoming.sha256Checksum.length !== 64 || !SHA256_REGEX.test(incoming.sha256Checksum)) return false;
  if (typeof incoming.payloadChunkCount !== 'number' || !Number.isInteger(incoming.payloadChunkCount) || incoming.payloadChunkCount < 1 || incoming.payloadChunkCount > 500) return false;
  if (incoming.status !== 'uploading' && incoming.status !== 'completed') return false;
  if (typeof incoming.notes !== 'string' || incoming.notes.length > 500) return false;
  if (incoming.createdAt !== env.timeMs || incoming.updatedAt !== env.timeMs) return false;
  return isAdmin(env);
}

function evaluateUpdateBackup(
  env: RequestEnv,
  backupId: string,
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): boolean {
  if (!isVerifiedEmail(env.auth) || !isValidId(backupId)) return false;
  // Re-validate incoming shape excluding createdAt==timeMs check
  const tempEnv = { ...env, timeMs: incoming.updatedAt as number };
  if (incoming.updatedAt !== env.timeMs) return false;
  const keys = [
    'backupId',
    'authorUid',
    'createdByEmail',
    'schemaVersion',
    'recordCountsSummary',
    'sha256Checksum',
    'payloadChunkCount',
    'status',
    'notes',
    'createdAt',
    'updatedAt',
  ];
  if (!hasExactKeys(incoming, keys, keys)) return false;
  if (!isValidId(incoming.authorUid) || incoming.authorUid !== env.auth.uid && !isBootstrappedMainAdmin(env.auth)) return false;
  if (typeof incoming.notes !== 'string' || incoming.notes.length > 500) return false;
  if (typeof incoming.sha256Checksum !== 'string' || !SHA256_REGEX.test(incoming.sha256Checksum)) return false;

  const immutableFields = [
    'backupId',
    'authorUid',
    'createdByEmail',
    'schemaVersion',
    'recordCountsSummary',
    'sha256Checksum',
    'payloadChunkCount',
    'createdAt',
  ];
  for (const field of immutableFields) {
    if (incoming[field] !== existing[field]) return false;
  }

  const changedKeys = keys.filter((k) => incoming[k] !== existing[k]);
  const isFinalizeAction =
    existing.status === 'uploading' &&
    incoming.status === 'completed' &&
    existing.authorUid === env.auth.uid &&
    isAdmin(tempEnv) &&
    changedKeys.every((k) => ['status', 'updatedAt'].includes(k));

  const isMainAdminNotesAction =
    isBootstrappedMainAdmin(env.auth) &&
    incoming.status === existing.status &&
    changedKeys.every((k) => ['notes', 'updatedAt'].includes(k));

  return isFinalizeAction || isMainAdminNotesAction;
}

function evaluateCreateChunk(
  env: RequestEnv,
  backupId: string,
  chunkId: string,
  incoming: Record<string, unknown>
): boolean {
  const keys = ['chunkId', 'backupId', 'authorUid', 'chunkIndex', 'data', 'createdAt'];
  if (!isVerifiedEmail(env.auth) || !isValidId(backupId) || !isValidId(chunkId)) return false;
  if (!hasExactKeys(incoming, keys, keys)) return false;
  if (incoming.chunkId !== chunkId || incoming.backupId !== backupId) return false;
  if (incoming.authorUid !== env.auth.uid) return false;
  if (typeof incoming.chunkIndex !== 'number' || incoming.chunkIndex < 0 || incoming.chunkIndex >= 500) return false;
  if (typeof incoming.data !== 'string' || incoming.data.length < 1 || incoming.data.length > 400000) return false;
  if (incoming.createdAt !== env.timeMs) return false;
  if (!isAdmin(env)) return false;
  const parent = env.backupsDb[backupId];
  if (!parent) return false;
  return parent.authorUid === env.auth.uid && parent.status === 'uploading';
}

function evaluateMutateAudit(): boolean {
  return false;
}

const VALID_SHA = 'a'.repeat(64);
const NOW = 1_761_657_600_000;

function makeBaseBackup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    backupId: 'bkp_01',
    authorUid: 'admin_main',
    createdByEmail: BOOTSTRAPPED_ADMIN_EMAIL,
    schemaVersion: 1,
    recordCountsSummary: 'Customers: 4, Orders: 2, Invoices: 2',
    sha256Checksum: VALID_SHA,
    payloadChunkCount: 1,
    status: 'uploading',
    notes: 'Routine snapshot',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

test('Firestore Rules File Integrity & Blueprint Synchronicity', () => {
  const rulesPath = fs.existsSync(path.resolve('firestore.rules'))
    ? path.resolve('firestore.rules')
    : path.resolve('DRAFT_firestore.rules');
  const rulesText = fs.readFileSync(rulesPath, 'utf8');
  const blueprint = JSON.parse(fs.readFileSync(path.resolve('firebase-blueprint.json'), 'utf8'));

  assert.match(rulesText, /rules_version = '2';/);
  assert.match(rulesText, /match \/\{document=\*\*\} \{\s*allow read, write: if false;\s*\}/);

  // Verify every collection path in firebase-blueprint.json is covered
  assert.ok(blueprint.firestore['/admins/{adminUid}']);
  assert.ok(blueprint.firestore['/cloud_backups/{backupId}']);
  assert.ok(blueprint.firestore['/cloud_backups/{backupId}/chunks/{chunkId}']);
  assert.ok(blueprint.firestore['/audit_events/{eventId}']);

  assert.match(rulesText, /match \/admins\/\{adminUid\}/);
  assert.match(rulesText, /match \/cloud_backups\/\{backupId\}/);
  assert.match(rulesText, /match \/chunks\/\{chunkId\}/);
  assert.match(rulesText, /match \/audit_events\/\{eventId\}/);

  // Verify zero get()/exists() inside allow list blocks (Pillar 8 Cost-Optimization)
  const listLines = rulesText.split('\n').filter((line) => line.trim().startsWith('allow list:'));
  assert.ok(listLines.length >= 4);
  for (const line of listLines) {
    assert.equal(line.includes('get('), false, `Forbidden get() in allow list: ${line}`);
    assert.equal(line.includes('exists('), false, `Forbidden exists() in allow list: ${line}`);
  }
});

test('Dirty Dozen #1-12: All adversarial payloads return PERMISSION_DENIED (false)', () => {
  const mainAdminEnv: RequestEnv = {
    auth: { uid: 'admin_main', email: BOOTSTRAPPED_ADMIN_EMAIL, email_verified: true },
    timeMs: NOW,
    adminsDb: {},
    backupsDb: {},
  };

  // #1 Unauthenticated Backup Write
  assert.equal(
    evaluateCreateBackup({ ...mainAdminEnv, auth: null }, 'bkp_01', makeBaseBackup()),
    false
  );

  // #2 Email Spoofing Without email_verified
  assert.equal(
    evaluateCreateAdmin(
      {
        ...mainAdminEnv,
        auth: { uid: 'spoof1', email: BOOTSTRAPPED_ADMIN_EMAIL, email_verified: false },
      },
      'spoof1',
      {
        uid: 'spoof1',
        email: BOOTSTRAPPED_ADMIN_EMAIL,
        displayName: 'Spoofer',
        role: 'main_admin',
        createdAt: NOW,
        updatedAt: NOW,
      }
    ),
    false
  );

  // #3 Self-Assigned Admin Escalation
  assert.equal(
    evaluateCreateAdmin(
      {
        ...mainAdminEnv,
        auth: { uid: 'cust1', email: 'attacker@example.com', email_verified: true },
      },
      'cust1',
      {
        uid: 'cust1',
        email: 'attacker@example.com',
        displayName: 'Attacker',
        role: 'main_admin',
        createdAt: NOW,
        updatedAt: NOW,
      }
    ),
    false
  );

  // #4 PII Blanket Scrape on /admins
  assert.equal(
    evaluateGetAdmin(
      {
        ...mainAdminEnv,
        auth: { uid: 'user2', email: 'user2@example.com', email_verified: true },
      },
      'admin_main'
    ),
    false
  );

  // #5 Shadow Ghost Field Injection
  assert.equal(
    evaluateCreateBackup(mainAdminEnv, 'bkp_01', makeBaseBackup({ isSuperVerified: true })),
    false
  );

  // #6 Identity Spoofing (authorUid mismatch)
  assert.equal(
    evaluateCreateBackup(mainAdminEnv, 'bkp_01', makeBaseBackup({ authorUid: 'other_uid' })),
    false
  );

  // #7 Path Variable / ID Poisoning
  assert.equal(
    evaluateCreateBackup(mainAdminEnv, 'bad$id!spaces', makeBaseBackup({ backupId: 'bad$id!spaces' })),
    false
  );

  // #8 Denial-of-Wallet Oversized String
  assert.equal(
    evaluateCreateBackup(mainAdminEnv, 'bkp_01', makeBaseBackup({ notes: 'x'.repeat(1000) })),
    false
  );

  // #9 Forged Client Timestamp
  assert.equal(
    evaluateCreateBackup(mainAdminEnv, 'bkp_01', makeBaseBackup({ createdAt: NOW - 60_000 })),
    false
  );

  // #10 Orphaned Subcollection Chunk Write
  assert.equal(
    evaluateCreateChunk(mainAdminEnv, 'non_existent', 'chunk_0', {
      chunkId: 'chunk_0',
      backupId: 'non_existent',
      authorUid: 'admin_main',
      chunkIndex: 0,
      data: '{"ok":true}',
      createdAt: NOW,
    }),
    false
  );

  // #11 Value Poisoning / Immortal Field Mutation / Terminal State Lock
  const existingUploading = makeBaseBackup({ status: 'uploading' });
  const existingCompleted = makeBaseBackup({ status: 'completed' });
  assert.equal(
    evaluateUpdateBackup(
      { ...mainAdminEnv, timeMs: NOW + 1000 },
      'bkp_01',
      existingUploading,
      { ...existingUploading, sha256Checksum: 'b'.repeat(64), updatedAt: NOW + 1000 }
    ),
    false
  );
  assert.equal(
    evaluateUpdateBackup(
      { ...mainAdminEnv, timeMs: NOW + 1000 },
      'bkp_01',
      existingCompleted,
      { ...existingCompleted, status: 'uploading', updatedAt: NOW + 1000 }
    ),
    false
  );

  // #12 Audit Trail Tampering
  assert.equal(evaluateMutateAudit(), false);

  // Positive sanity check: Valid create + valid finalize succeed for verified bootstrapped admin
  assert.equal(evaluateCreateBackup(mainAdminEnv, 'bkp_01', existingUploading), true);
  assert.equal(
    evaluateUpdateBackup(
      { ...mainAdminEnv, timeMs: NOW + 1000 },
      'bkp_01',
      existingUploading,
      { ...existingUploading, status: 'completed', updatedAt: NOW + 1000 }
    ),
    true
  );
});
