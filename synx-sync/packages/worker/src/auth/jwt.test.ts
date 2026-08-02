import { describe, it, expect } from 'vitest';
import { signJwt, verifyJwt } from './jwt.js';

const SECRET = 'test-jwt-secret-min-32-characters-pls!';

describe('jwt', () => {
  it('sign and verify round-trip', async () => {
    const token = await signJwt({ sub: 'user-1' }, SECRET);
    const payload = await verifyJwt(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload?.sub).toBe('user-1');
    expect(payload?.iat).toBeTypeOf('number');
    expect(payload?.exp).toBeTypeOf('number');
  });

  it('returns null for expired token', async () => {
    const token = await signJwt({ sub: 'user-1' }, SECRET, -10); // 已过期 10s
    expect(await verifyJwt(token, SECRET)).toBeNull();
  });

  it('returns null for tampered signature', async () => {
    const token = await signJwt({ sub: 'user-1' }, SECRET);
    const [h, p] = token.split('.');
    const tampered = `${h}.${p}.aW52YWxpZHNpZw`;
    expect(await verifyJwt(tampered, SECRET)).toBeNull();
  });

  it('returns null for wrong secret', async () => {
    const token = await signJwt({ sub: 'user-1' }, SECRET);
    expect(await verifyJwt(token, 'other-secret-min-32-characters-ok!')).toBeNull();
  });

  it('returns null for malformed token', async () => {
    expect(await verifyJwt('not-a-jwt', SECRET)).toBeNull();
  });
});
