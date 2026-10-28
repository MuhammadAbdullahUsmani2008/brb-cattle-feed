import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import type { User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestoreInstance();
export const auth = getAuth(app);

import { getFirestore } from 'firebase/firestore';
function getFirestoreInstance() {
  return getFirestore(app, firebaseConfig.firestoreDatabaseId);
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

let connectionTested = false;
export async function testFirestoreConnection(): Promise<void> {
  if (connectionTested) return;
  connectionTested = true;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

// Boot-time connectivity validation per Firebase integration guidelines
void testFirestoreConnection();

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_CHUNK_CHARS = 350_000; // Strictly <= 400,000 maxLength in firebase-blueprint.json

function sanitizeFirestoreId(raw: string, fallbackPrefix: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  if (cleaned.length >= 1 && ID_PATTERN.test(cleaned)) {
    return cleaned;
  }
  return `${fallbackPrefix}_${Date.now()}`;
}

export function subscribeFirebaseAdminUser(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, callback);
}

export async function signInFirebaseCloudAdmin(): Promise<User> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const cred = await signInWithPopup(auth, provider);
  return cred.user;
}

export async function signOutFirebaseCloudAdmin(): Promise<void> {
  await signOut(auth);
}

export interface CloudBackupHeaderView {
  backupId: string;
  authorUid: string;
  createdByEmail: string;
  schemaVersion: number;
  recordCountsSummary: string;
  sha256Checksum: string;
  payloadChunkCount: number;
  status: 'uploading' | 'completed';
  notes: string;
  createdAtIso: string;
}

export async function uploadBackupSnapshotToCloud(params: {
  backupUid: string;
  schemaVersion: number;
  recordCountsSummary: string;
  sha256Checksum: string;
  notes: string;
  bundleJson: string;
}): Promise<string> {
  const user = auth.currentUser;
  if (!user || !user.email || !user.emailVerified) {
    throw new Error('Sign in with a verified administrator Google account to sync cloud backups.');
  }

  const backupId = sanitizeFirestoreId(params.backupUid, 'bkp');
  const sha = params.sha256Checksum.toLowerCase().trim();
  if (!SHA256_PATTERN.test(sha)) {
    throw new Error('Invalid SHA-256 checksum format for cloud backup.');
  }

  const chunks: string[] = [];
  for (let i = 0; i < params.bundleJson.length; i += MAX_CHUNK_CHARS) {
    chunks.push(params.bundleJson.slice(i, i + MAX_CHUNK_CHARS));
  }
  if (chunks.length === 0 || chunks.length > 500) {
    throw new Error(`Backup payload chunk count (${chunks.length}) is out of bounds.`);
  }

  const headerPath = `cloud_backups/${backupId}`;
  try {
    await setDoc(doc(db, 'cloud_backups', backupId), {
      backupId,
      authorUid: user.uid.slice(0, 128),
      createdByEmail: user.email.slice(0, 254),
      schemaVersion: Math.max(1, Math.min(1000, Math.floor(params.schemaVersion))),
      recordCountsSummary: (params.recordCountsSummary || 'Snapshot').slice(0, 500),
      sha256Checksum: sha,
      payloadChunkCount: chunks.length,
      status: 'uploading',
      notes: (params.notes || '').slice(0, 500),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, headerPath);
  }

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunkId = `chunk_${String(idx).padStart(4, '0')}`;
    const chunkPath = `cloud_backups/${backupId}/chunks/${chunkId}`;
    try {
      await setDoc(doc(db, 'cloud_backups', backupId, 'chunks', chunkId), {
        chunkId,
        backupId,
        authorUid: user.uid.slice(0, 128),
        chunkIndex: idx,
        data: chunks[idx],
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, chunkPath);
    }
  }

  try {
    await updateDoc(doc(db, 'cloud_backups', backupId), {
      status: 'completed',
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, headerPath);
  }

  // Record immutable cloud audit event
  const eventId = sanitizeFirestoreId(`aud_${backupId}`, 'aud');
  try {
    await setDoc(doc(db, 'audit_events', eventId), {
      eventId,
      authorUid: user.uid.slice(0, 128),
      actorName: (user.displayName || user.email).slice(0, 120),
      action: 'CLOUD_BACKUP_UPLOADED',
      entityType: 'cloud_backup',
      entityId: backupId,
      summary: `Uploaded verified BRB backup ${backupId} (SHA-256 ${sha.slice(0, 16)}...)`.slice(0, 1000),
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `audit_events/${eventId}`);
  }

  return backupId;
}

export async function listCloudBackups(): Promise<CloudBackupHeaderView[]> {
  const user = auth.currentUser;
  if (!user) return [];
  const path = 'cloud_backups';
  try {
    const q = query(collection(db, 'cloud_backups'), where('authorUid', '==', user.uid));
    const snap = await getDocs(q);
    const items: CloudBackupHeaderView[] = snap.docs.map((d) => {
      const data = d.data();
      const ts = data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : '';
      return {
        backupId: String(data.backupId || d.id),
        authorUid: String(data.authorUid || ''),
        createdByEmail: String(data.createdByEmail || ''),
        schemaVersion: Number(data.schemaVersion || 1),
        recordCountsSummary: String(data.recordCountsSummary || ''),
        sha256Checksum: String(data.sha256Checksum || ''),
        payloadChunkCount: Number(data.payloadChunkCount || 1),
        status: data.status === 'completed' ? 'completed' : 'uploading',
        notes: String(data.notes || ''),
        createdAtIso: ts,
      };
    });
    items.sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));
    return items;
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, path);
  }
}

export async function downloadCloudBackupBundle(backupId: string): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Sign in with your administrator Google account first.');
  }
  const cleanId = sanitizeFirestoreId(backupId, 'bkp');
  const headerPath = `cloud_backups/${cleanId}`;
  let chunkCount = 0;

  try {
    const headerSnap = await getDoc(doc(db, 'cloud_backups', cleanId));
    if (!headerSnap.exists()) {
      throw new Error(`Cloud backup "${cleanId}" was not found.`);
    }
    const header = headerSnap.data();
    if (header.status !== 'completed') {
      throw new Error(`Cloud backup "${cleanId}" is incomplete (${String(header.status)}).`);
    }
    chunkCount = Number(header.payloadChunkCount || 0);
  } catch (err) {
    if (err instanceof Error && err.message.includes('Missing or insufficient permissions')) {
      handleFirestoreError(err, OperationType.GET, headerPath);
    }
    throw err;
  }

  const chunksPath = `cloud_backups/${cleanId}/chunks`;
  try {
    const q = query(
      collection(db, 'cloud_backups', cleanId, 'chunks'),
      where('authorUid', '==', user.uid),
      orderBy('chunkIndex', 'asc')
    );
    const snap = await getDocs(q);
    if (snap.docs.length !== chunkCount) {
      // Fallback sequential getDoc by chunkId so composite index creation is never required
      const parts: string[] = [];
      for (let idx = 0; idx < chunkCount; idx++) {
        const chunkId = `chunk_${String(idx).padStart(4, '0')}`;
        const cDoc = await getDoc(doc(db, 'cloud_backups', cleanId, 'chunks', chunkId));
        if (!cDoc.exists()) {
          throw new Error(`Missing backup chunk ${chunkId}.`);
        }
        parts.push(String(cDoc.data().data || ''));
      }
      return parts.join('');
    }
    return snap.docs.map((d) => String(d.data().data || '')).join('');
  } catch {
    // Fallback to direct document reads by deterministic chunkId (avoids composite index dependency)
    const parts: string[] = [];
    for (let idx = 0; idx < chunkCount; idx++) {
      const chunkId = `chunk_${String(idx).padStart(4, '0')}`;
      const singlePath = `${chunksPath}/${chunkId}`;
      try {
        const cDoc = await getDoc(doc(db, 'cloud_backups', cleanId, 'chunks', chunkId));
        if (!cDoc.exists()) {
          throw new Error(`Missing backup chunk ${chunkId}.`);
        }
        parts.push(String(cDoc.data().data || ''));
      } catch (innerErr) {
        handleFirestoreError(innerErr, OperationType.GET, singlePath);
      }
    }
    return parts.join('');
  }
}

export const FIREBASE_PROJECT_ID = firebaseConfig.projectId;
export const FIRESTORE_DATABASE_ID = firebaseConfig.firestoreDatabaseId;
