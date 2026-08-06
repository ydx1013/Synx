import { describe, expect, it } from 'vitest';
import { FifoSerializer } from './fifoSerializer.js';

describe('FifoSerializer', () => {
  it('runs mutually exclusively in FIFO order', async () => {
    const serializer = new FifoSerializer();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const first = serializer.run(async () => { events.push('first:start'); await gate; events.push('first:end'); });
    const second = serializer.run(async () => { events.push('second:start'); });
    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('continues after an error', async () => {
    const serializer = new FifoSerializer();
    const first = serializer.run(async () => { throw new Error('boom'); });
    const second = serializer.run(async () => 'ok');
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('ok');
  });

  it('returns the operation value', async () => {
    await expect(new FifoSerializer().run(async () => 42)).resolves.toBe(42);
  });
});
