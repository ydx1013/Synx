import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncScheduler } from './syncScheduler.js';

const settings = {
  periodicSyncEnabled: true,
  autoSyncIntervalMin: 5,
  startupSyncEnabled: true,
  startupDelaySec: 5,
  saveSyncDelaySec: 5,
};

afterEach(() => vi.useRealTimers());

describe('SyncScheduler', () => {
  it('schedules startup, periodic, and debounced save triggers', async () => {
    vi.useFakeTimers();
    const triggers: string[] = [];
    const scheduler = new SyncScheduler(settings, async (trigger) => { triggers.push(trigger); });
    scheduler.start();
    scheduler.notifySave();
    scheduler.notifySave();

    await vi.advanceTimersByTimeAsync(5000);
    expect(triggers.sort()).toEqual(['save', 'startup']);
    await vi.advanceTimersByTimeAsync(295000);
    expect(triggers).toContain('timer');
    scheduler.dispose();
  });

  it('does not schedule disabled triggers', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const scheduler = new SyncScheduler({ ...settings, periodicSyncEnabled: false, startupSyncEnabled: false, saveSyncDelaySec: 0 }, run);
    scheduler.start();
    scheduler.notifySave();
    await vi.runAllTimersAsync();
    expect(run).not.toHaveBeenCalled();
  });

  it('coalesces triggers during sync into one pending run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const triggers: string[] = [];
    const scheduler = new SyncScheduler(settings, async (trigger) => {
      triggers.push(trigger);
      if (triggers.length === 1) await gate;
    });
    const first = scheduler.trigger('manual');
    await Promise.resolve();
    void scheduler.trigger('save');
    void scheduler.trigger('timer');
    release();
    await first;
    await Promise.resolve();

    expect(triggers).toEqual(['manual', 'timer']);
  });

  it('reschedules timers when settings change', async () => {
    vi.useFakeTimers();
    const triggers: string[] = [];
    const scheduler = new SyncScheduler(settings, async (trigger) => { triggers.push(trigger); });
    scheduler.start();
    scheduler.updateSettings({ ...settings, autoSyncIntervalMin: 1, startupSyncEnabled: false });
    await vi.advanceTimersByTimeAsync(60000);
    expect(triggers).toEqual(['timer']);
  });
});
