import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Derive a 32-byte AES key from a host-provided secret.
 * @param {string} secret
 * @returns {Buffer}
 */
export function deriveSealKey(secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('idpTokenEncryptionKey must be a string of at least 32 characters');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

/**
 * Encrypt a UTF-8 string. Returns `iv:authTag:ciphertext` (base64url segments).
 * @param {string} plaintext
 * @param {Buffer} key
 * @returns {string}
 */
export function seal(plaintext, key) {
  if (typeof plaintext !== 'string' || !plaintext) {
    throw new Error('plaintext is required');
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('seal key must be a 32-byte Buffer');
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString('base64url'),
    authTag.toString('base64url'),
    encrypted.toString('base64url')
  ].join(':');
}

/**
 * Decrypt a sealed string produced by {@link seal}.
 * @param {string} sealed
 * @param {Buffer} key
 * @returns {string}
 */
export function unseal(sealed, key) {
  if (typeof sealed !== 'string' || !sealed) {
    throw new Error('sealed value is required');
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('seal key must be a 32-byte Buffer');
  }
  const parts = sealed.split(':');
  if (parts.length !== 3) {
    throw new Error('sealed value must have three base64url segments');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64url');
  const authTag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');
  if (iv.length !== IV_LENGTH) {
    throw new Error('sealed value has invalid iv length');
  }
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('sealed value has invalid auth tag length');
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
