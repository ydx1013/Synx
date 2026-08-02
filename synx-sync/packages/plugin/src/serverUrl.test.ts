import { describe, expect, it } from 'vitest';
import { assertSecureServerUrl } from './workerClient.js';

describe('assertSecureServerUrl', () => {
  it('accepts HTTPS URLs', () => {
    expect(() => assertSecureServerUrl('https://synx.example.com')).not.toThrow();
  });

  it('accepts local HTTP URLs for development', () => {
    expect(() => assertSecureServerUrl('http://localhost:8787')).not.toThrow();
    expect(() => assertSecureServerUrl('http://127.0.0.1:8787')).not.toThrow();
  });

  it('rejects non-local HTTP URLs', () => {
    expect(() => assertSecureServerUrl('http://synx.example.com')).toThrow('服务器地址必须使用 HTTPS');
  });

  it('rejects invalid URLs', () => {
    expect(() => assertSecureServerUrl('not-a-url')).toThrow('服务器地址无效');
  });
});
