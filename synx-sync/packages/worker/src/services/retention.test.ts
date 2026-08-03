import { describe, expect, it, beforeEach } from 'vitest';
import { DEFAULT_RETENTION, type RetentionPolicy, type WorkerFs } from '@synx/shared';
import {
  FileTooLarge,
  enforceMaxFileSize,
  getRetentionPolicy,
  normalizePolicy,
  resetRetentionPolicyCache,
  saveRetentionPolicy,
} from './retention.js';

/** 内存 WorkerFs mock：get 不存在时抛错（与真实存储一致） */
function makeFs(initial: Record<string, string> = {}): WorkerFs & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(initial)) store.set(k, new TextEncoder().encode(v));
  return {
    store,
    async put(key, content) {
      store.set(key, content instanceof Uint8Array ? content : new Uint8Array(content));
    },
    async get(key) {
      const value = store.get(key);
      if (!value) throw new Error(`no such key: ${key}`);
      return value as unknown as ArrayBuffer;
    },
    async delete(key) {
      store.delete(key);
    },
    async list() {
      return [...store.keys()];
    },
    async head() {
      return store.has('x');
    },
  };
}

describe('enforceMaxFileSize', () => {
  it('passes when size does not exceed max', () => {
    const policy = { maxVersionsPerFile: 0, maxFileSize: 100 } as RetentionPolicy;
    expect(() => enforceMaxFileSize(100, policy)).not.toThrow();
  });

  it('throws FileTooLarge when size exceeds max', () => {
    const policy = { maxVersionsPerFile: 0, maxFileSize: 100 } as RetentionPolicy;
    expect(() => enforceMaxFileSize(101, policy)).toThrow(FileTooLarge);
  });

  it('passes when maxFileSize is unlimited', () => {
    const policy = { maxVersionsPerFile: 0, maxFileSize: 0 } as RetentionPolicy;
    expect(() => enforceMaxFileSize(Number.MAX_SAFE_INTEGER, policy)).not.toThrow();
  });
});

describe('getRetentionPolicy', () => {
  beforeEach(() => {
    resetRetentionPolicyCache();
  });

  it('returns the default retention policy', async () => {
    const db = {
      prepare: () => ({ bind: () => ({ first: async () => null }) }),
    };
    await expect(getRetentionPolicy({ DB: db } as any, 'storage-1')).resolves.toEqual(DEFAULT_RETENTION);
  });

  it('reads a stored policy from D1', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({ first: async () => ({ retention_policy: JSON.stringify({ hourlyWindowHours: 12, dailyWindowDays: 7 }) }) }),
      }),
    };
    const policy = await getRetentionPolicy({ DB: db } as any, 'storage-1');
    expect(policy.hourlyWindowHours).toBe(12);
    expect(policy.dailyWindowDays).toBe(7);
    expect(policy.maxVersionsPerFile).toBe(DEFAULT_RETENTION.maxVersionsPerFile);
  });

  it('falls back to default when stored policy is invalid JSON', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({ first: async () => ({ retention_policy: 'not-json' }) }),
      }),
    };
    await expect(getRetentionPolicy({ DB: db } as any, 'storage-1')).resolves.toEqual(DEFAULT_RETENTION);
  });

  it('reads policy from user storage when file exists (no D1 query)', async () => {
    const fs = makeFs({ '.synx/retention.json': JSON.stringify({ hourlyWindowHours: 12, dailyWindowDays: 7 }) });
    const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };
    const policy = await getRetentionPolicy({ DB: db } as any, 'storage-1', fs);
    expect(policy.hourlyWindowHours).toBe(12);
    expect(policy.dailyWindowDays).toBe(7);
    expect(policy.maxVersionsPerFile).toBe(DEFAULT_RETENTION.maxVersionsPerFile);
  });

  it('falls back to D1 when storage file is missing', async () => {
    const fs = makeFs({});
    const db = {
      prepare: () => ({
        bind: () => ({ first: async () => ({ retention_policy: JSON.stringify({ hourlyWindowHours: 48 }) }) }),
      }),
    };
    const policy = await getRetentionPolicy({ DB: db } as any, 'storage-1', fs);
    expect(policy.hourlyWindowHours).toBe(48);
  });

  it('migrates D1 legacy value into user storage when file is missing', async () => {
    const fs = makeFs({});
    const db = {
      prepare: () => ({
        bind: () => ({ first: async () => ({ retention_policy: JSON.stringify({ dailyWindowDays: 14 }) }) }),
      }),
    };
    await getRetentionPolicy({ DB: db } as any, 'storage-1', fs);
    expect(fs.store.has('.synx/retention.json')).toBe(true);
    const migrated = JSON.parse(new TextDecoder().decode(fs.store.get('.synx/retention.json'))) as RetentionPolicy;
    expect(migrated.dailyWindowDays).toBe(14);
  });

  it('serves cached policy without re-reading storage', async () => {
    let reads = 0;
    const fs = {
      ...makeFs({}),
      get: async (key: string) => {
        reads++;
        return new TextEncoder().encode(JSON.stringify({ hourlyWindowHours: 6 })).buffer as unknown as ArrayBuffer;
      },
    };
    const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };
    const env = { DB: db } as any;
    await getRetentionPolicy(env, 'storage-1', fs);
    const second = await getRetentionPolicy(env, 'storage-1', fs);
    expect(second.hourlyWindowHours).toBe(6);
    expect(reads).toBe(1);
  });
});

describe('saveRetentionPolicy', () => {
  beforeEach(() => {
    resetRetentionPolicyCache();
  });

  it('writes policy to user storage and serves it back on next read', async () => {
    const fs = makeFs({});
    const db = {
      prepare: () => ({ bind: () => ({ first: async () => null }) }),
      run: async () => ({ success: true }),
    };
    const policy = normalizePolicy({ hourlyWindowHours: 24, dailyWindowDays: 3 });
    const env = { DB: db } as any;
    await saveRetentionPolicy(env, 'storage-1', fs, policy);
    expect(fs.store.has('.synx/retention.json')).toBe(true);
    const read = await getRetentionPolicy(env, 'storage-1', fs);
    expect(read.hourlyWindowHours).toBe(24);
  });

  it('propagates storage write failure (storage is the authoritative source)', async () => {
    const fs = makeFs({});
    const broken = { ...fs, put: async () => { throw new Error('storage unreachable'); } };
    const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };
    await expect(saveRetentionPolicy({ DB: db } as any, 'storage-1', broken, normalizePolicy({}))).rejects.toThrow('storage unreachable');
  });
});

describe('normalizePolicy', () => {
  it('clamps negative and non-numeric values to defaults', () => {
    const policy = normalizePolicy({ hourlyWindowHours: -5, maxVersionsPerFile: Number.NaN } as any);
    expect(policy.hourlyWindowHours).toBe(DEFAULT_RETENTION.hourlyWindowHours);
    expect(policy.maxVersionsPerFile).toBe(DEFAULT_RETENTION.maxVersionsPerFile);
  });
});
