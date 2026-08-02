import { vi } from 'vitest';

interface D1MockOptions {
  /** prepare().first() 返回值；传函数则每次调用动态返回 */
  first?: unknown | (() => unknown);
  all?: unknown[];
}

/** 简单 D1 mock：记录调用，按配置返回。不解析 SQL（业务正确性由 e2e 验证） */
export function makeD1Mock(opts: D1MockOptions = {}) {
  const firstImpl = typeof opts.first === 'function' ? (opts.first as () => unknown) : () => opts.first ?? null;
  const first = vi.fn(async () => firstImpl());
  const all = vi.fn(async () => ({ results: opts.all ?? [], success: true, meta: {} }));
  const run = vi.fn(async () => ({ success: true, meta: { changes: 1, last_row_id: 1 } }));
  const stmt: Record<string, ReturnType<typeof vi.fn>> = { bind: vi.fn(), first, all, run };
  // bind 返回 stmt 自身（链式）
  stmt.bind = vi.fn(() => stmt);
  const prepare = vi.fn(() => stmt);
  const batch = vi.fn(async (stmts: unknown[]) => stmts.map(() => ({ success: true, meta: { changes: 1, last_row_id: 1 } })));
  return { prepare, batch, _stmt: stmt, _first: first, _run: run, _all: all } as unknown as D1Database & {
    _first: ReturnType<typeof vi.fn>;
    _run: ReturnType<typeof vi.fn>;
  };
}

/** 内存 KV mock */
export function makeKvMock() {
  const map = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => map.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      map.set(key, value);
      return null;
    }),
    _map: map,
  } as unknown as KVNamespace & { _map: Map<string, string> };
}

/** 构造 Env（用 mock bindings） */
export function makeEnv(overrides: Partial<{ DB: D1Database; KV: KVNamespace; JWT_SECRET: string; ENCRYPTION_KEY: string }> = {}) {
  return {
    DB: makeD1Mock(),
    KV: makeKvMock(),
    ASSETS: {} as Fetcher,
    JWT_SECRET: 'test-jwt-secret-min-32-characters-pls!',
    ENCRYPTION_KEY: 'test-encryption-key',
    ENVIRONMENT: 'test',
    ...overrides,
  } as unknown as import('../types.js').Env;
}
