import { describe, expect, it } from 'vitest';
import { StorageRequestError } from '@synx/storage-core';
import { SyncExecutor, type ExecutableSyncAction } from './syncExecutor.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('SyncExecutor', () => {
  it('limits concurrent operations and continues after individual failures', async () => {
    let active = 0;
    let maxActive = 0;
    const gate = deferred();
    const actions: ExecutableSyncAction[] = ['a.md', 'b.md', 'c.md'].map((path) => ({ type: 'push', path, reason: 'local-only' }));
    const executor = new SyncExecutor(2, async (action) => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (action.path === 'a.md') await gate.promise;
      if (action.path === 'b.md') throw new Error('boom');
      active--;
    });

    const running = executor.execute(actions);
    await Promise.resolve();
    expect(maxActive).toBe(2);
    gate.resolve();
    const results = await running;

    expect(maxActive).toBe(2);
    expect(results).toHaveLength(3);
    expect(results.find((result) => result.path === 'b.md')?.status).toBe('failed');
    expect(results.find((result) => result.path === 'c.md')?.status).toBe('success');
  });

  it('serializes operations for the same path', async () => {
    const order: string[] = [];
    const gate = deferred();
    const executor = new SyncExecutor(3, async (action) => {
      order.push(`start:${action.type}:${action.path}`);
      if (action.type === 'push') await gate.promise;
      order.push(`end:${action.type}:${action.path}`);
    });
    const running = executor.execute([
      { type: 'push', path: 'same.md', reason: 'local-only' },
      { type: 'pull', path: 'same.md', reason: 'remote-newer' },
      { type: 'push', path: 'other.md', reason: 'local-only' },
    ]);
    await Promise.resolve();

    expect(order).toContain('start:push:other.md');
    expect(order).not.toContain('start:pull:same.md');
    gate.resolve();
    await running;
    expect(order.indexOf('end:push:same.md')).toBeLessThan(order.indexOf('start:pull:same.md'));
  });

  it('emits skipped actions without invoking IO', async () => {
    let calls = 0;
    const events: string[] = [];
    const executor = new SyncExecutor(1, async () => { calls++; }, (event) => events.push(event.type));
    const results = await executor.execute([{ type: 'skip', path: 'large.bin', reason: 'filtered', size: 30, rule: 'size>20MB' }]);

    expect(calls).toBe(0);
    expect(results[0]).toMatchObject({ status: 'skipped', path: 'large.bin', rule: 'size>20MB' });
    expect(events).toEqual(['skipped']);
  });

  it('keeps a structured storage error internally after converting a file failure to a result', async () => {
    const original = new StorageRequestError(403, 's3 get failed (403) accessKey=do-not-report');
    const results = await new SyncExecutor(1, async () => { throw original; }).execute([
      { type: 'pull', path: 'secret.md', reason: 'remote-newer' },
    ]);

    expect(results[0].cause).toBe(original);
    expect(results[0].error).toMatchObject({ status: 403, category: 'permission' });
    expect(JSON.stringify(results[0].error)).not.toContain('do-not-report');
  });

  it('reports protected writes without counting them as successful actions', async () => {
    const events: string[] = [];
    const executor = new SyncExecutor(1, async () => 'protected', (event) => events.push(event.type));
    const results = await executor.execute([{ type: 'delete-local', path: 'edited.md', reason: 'remote-deleted' }]);

    expect(results[0]).toMatchObject({ status: 'protected', operation: 'delete-local', path: 'edited.md' });
    expect(events).toEqual(['started', 'protected']);
  });
});
