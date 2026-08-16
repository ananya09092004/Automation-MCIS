const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

function encrypt(plainText, keyBuffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64')
  };
}

function decrypt({ ciphertext, iv, authTag }, keyBuffer) {
  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final()
  ]);

  return decrypted.toString('utf8');
}

function generateKey() {
  return crypto.randomBytes(32);
}

module.exports = { encrypt, decrypt, generateKey };
