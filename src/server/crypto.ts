import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash || !storedHash.startsWith('scrypt$')) {
    return false;
  }
  const parts = storedHash.split('$');
  if (parts.length !== 3) {
    return false;
  }
  const [, salt, hexDigest] = parts;
  const expected = Buffer.from(hexDigest, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

export function generateSessionToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(rawToken);
  return { rawToken, tokenHash };
}

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function generateNumericOtp(): string {
  return String(crypto.randomInt(100_000, 1_000_000));
}

export function hashOtp(otp: string, contextKey: string): string {
  const pepper = process.env.BRB_OTP_PEPPER || 'brb-dev-local-pepper-override-in-prod';
  return crypto
    .createHmac('sha256', pepper)
    .update(`${contextKey}:${otp.trim()}`, 'utf8')
    .digest('hex');
}

export function verifyOtpDigest(otp: string, contextKey: string, expectedDigestHex: string): boolean {
  const actualHex = hashOtp(otp, contextKey);
  const a = Buffer.from(actualHex, 'hex');
  const b = Buffer.from(expectedDigestHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function computeSha256Hex(payload: string): string {
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function encryptBackupPayload(plaintextJson: string, passphrase: string): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintextJson, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return JSON.stringify({
    alg: 'AES-256-GCM',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: authTag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
  });
}

export function decryptBackupPayload(encryptedEnvelopeJson: string, passphrase: string): string {
  const parsed = JSON.parse(encryptedEnvelopeJson) as {
    alg: string;
    salt: string;
    iv: string;
    tag: string;
    ciphertext: string;
  };
  if (parsed.alg !== 'AES-256-GCM') {
    throw new Error('Unsupported backup encryption algorithm.');
  }
  const salt = Buffer.from(parsed.salt, 'base64');
  const iv = Buffer.from(parsed.iv, 'base64');
  const tag = Buffer.from(parsed.tag, 'base64');
  const ciphertext = Buffer.from(parsed.ciphertext, 'base64');
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}
