import { describe, it, expect } from 'vitest';
import { encryptString, decryptString } from './crypto.js';

const KEY = 'test-encryption-key';

describe('crypto (AES-256-GCM)', () => {
  it('encrypt and decrypt round-trip', async () => {
    const plaintext = JSON.stringify({ accessKey: 'AKIA...', secretKey: 'very-secret' });
    const encrypted = await encryptString(plaintext, KEY);
    expect(encrypted).not.toBe(plaintext);
    const decrypted = await decryptString(encrypted, KEY);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertext for same plaintext (random iv)', async () => {
    const a = await encryptString('same', KEY);
    const b = await encryptString('same', KEY);
    expect(a).not.toBe(b);
    expect(await decryptString(b, KEY)).toBe('same');
  });

  it('fails to decrypt with wrong key', async () => {
    const encrypted = await encryptString('secret', KEY);
    await expect(decryptString(encrypted, 'other-key')).rejects.toThrow();
  });

  it('handles unicode content', async () => {
    const plaintext = '中文测试 🔐 éàü';
    const encrypted = await encryptString(plaintext, KEY);
    expect(await decryptString(encrypted, KEY)).toBe(plaintext);
  });
});
