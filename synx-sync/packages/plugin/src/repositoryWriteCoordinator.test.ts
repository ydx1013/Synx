import { describe, expect, it, vi } from 'vitest';
import type { RepositoryClient } from './repositoryClient.js';
import { RepositoryWriteCoordinator } from './repositoryWriteCoordinator.js';

const client = {} as RepositoryClient;

describe('RepositoryWriteCoordinator', () => {
  it('serializes sync, retry, and rollback in FIFO order', async () => {
    const coordinator = new RepositoryWriteCoordinator(async () => client);
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sync = coordinator.run(async () => { events.push('sync'); await gate; });
    const retry = coordinator.run(async () => { events.push('retry'); });
    const rollback = coordinator.run(async () => { events.push('rollback'); });
    await Promise.resolve(); await Promise.resolve();
    expect(events).toEqual(['sync']);
    release(); await Promise.all([sync, retry, rollback]);
    expect(events).toEqual(['sync', 'retry', 'rollback']);
  });

  it('queues repository scope transitions behind an active write without selecting a client', async () => {
    const select = vi.fn(async () => client);
    const coordinator = new RepositoryWriteCoordinator(select);
    const events: string[] = [];
    let release!: () => void;
    const sync = coordinator.run(async () => {
      events.push('sync-start');
      await new Promise<void>((resolve) => { release = resolve; });
      events.push('sync-end');
    });
    await vi.waitFor(() => expect(events).toEqual(['sync-start']));
    const transition = coordinator.runExclusive(async () => { events.push('scope-transition'); });
    await Promise.resolve();
    expect(events).toEqual(['sync-start']);
    release();
    await Promise.all([sync, transition]);
    expect(events).toEqual(['sync-start', 'sync-end', 'scope-transition']);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('continues after failure and selects one immutable client per round', async () => {
    const selected = [{ name: 'first' }, { name: 'second' }] as unknown as RepositoryClient[];
    const select = vi.fn(async () => selected.shift()!);
    const coordinator = new RepositoryWriteCoordinator(select);
    const seen: RepositoryClient[] = [];
    await expect(coordinator.run(async (roundClient) => { seen.push(roundClient, roundClient); throw new Error('fail'); })).rejects.toThrow('fail');
    await coordinator.run(async (roundClient) => { seen.push(roundClient, roundClient); });
    expect(seen[0]).toBe(seen[1]); expect(seen[2]).toBe(seen[3]); expect(seen[0]).not.toBe(seen[2]);
    expect(select).toHaveBeenCalledTimes(2);
  });
});
