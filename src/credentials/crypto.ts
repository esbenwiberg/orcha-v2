import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  const secret =
    process.env['ORCHA_ENCRYPTION_KEY'] ?? process.env['SESSION_SECRET'];
  if (!secret) {
    throw new Error(
      'No encryption key available. Set ORCHA_ENCRYPTION_KEY or SESSION_SECRET.',
    );
  }
  return crypto.scryptSync(secret, 'orcha-cred-salt', 32);
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
