import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

/** Cached derived key — scryptSync is intentionally slow, so we derive once. */
let _cachedKey: Buffer | undefined;

function getKey(): Buffer {
  if (_cachedKey !== undefined) return _cachedKey;

  const secret =
    process.env['ORCHA_ENCRYPTION_KEY'] ?? process.env['SESSION_SECRET'];
  if (!secret) {
    throw new Error(
      'No encryption key available. Set ORCHA_ENCRYPTION_KEY or SESSION_SECRET.',
    );
  }
  _cachedKey = crypto.scryptSync(secret, 'orcha-cred-salt', 32);
  return _cachedKey;
}

/** Encrypt plaintext → base64 string (iv + ciphertext + tag) */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // iv (12) + encrypted (N) + tag (16) → base64
  return Buffer.concat([iv, encrypted, tag]).toString('base64');
}

/** Decrypt base64 string → plaintext */
export function decrypt(encoded: string): string {
  const key = getKey();
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

/** Encrypt a JS object → base64 encrypted string */
export function encryptJson(obj: unknown): string {
  return encrypt(JSON.stringify(obj));
}

/**
 * Decrypt an encrypted JSON string → parsed object.
 * Supports lazy migration: if the value is still plaintext JSON
 * (pre-encryption data), falls back to JSON.parse directly.
 */
export function decryptJson<T = unknown>(raw: string): T {
  try {
    return JSON.parse(decrypt(raw)) as T;
  } catch {
    // Fallback: raw is plaintext JSON (pre-encryption data)
    return JSON.parse(raw) as T;
  }
}
