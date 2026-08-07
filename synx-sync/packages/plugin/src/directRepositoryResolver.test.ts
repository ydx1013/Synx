import { describe, expect, it, vi } from 'vitest';
import type { StorageCredentialsResponse, WorkerFs } from '@synx/shared';
import { DirectRepositoryClient } from './directRepositoryClient.js';
import { DirectRepositoryResolver, type DirectRepositoryScope } from './directRepositoryResolver.js';

const credentials = (storageId: string): StorageCredentialsResponse => ({
  storageId,
  type: 'webdav',
  config: { address: 'https://dav.example.com', username: 'user', password: 'secret', authType: 'basic' },
});

const scope = (patch: Partial<DirectRepositoryScope> = {}): DirectRepositoryScope => ({
  serverUrl: 'https://old.example.com',
  userId: 'user-1',
  jwt: 'jwt-1',
  storageId: 'storage-1',
  syncFolder: 'Vault',
  credentialGeneration: 0,
  ...patch,
});

const fs = {} as WorkerFs;

function makeResolver(provider = vi.fn(async (value: DirectRepositoryScope) => credentials(value.storageId))) {
  const createFs = vi.fn(() => fs);
  const createClient = vi.fn((storageId: string, syncFolder: string, value: WorkerFs) =>
    new DirectRepositoryClient(storageId, syncFolder, value));
  return {
    provider,
    createFs,
    createClient,
    resolver: new DirectRepositoryResolver(provider, createFs, createClient),
  };
}

describe('DirectRepositoryResolver', () => {
  it('single-flights credentials and client creation for concurrent requests in the same scope', async () => {
    let release!: (value: StorageCredentialsResponse) => void;
    const provider = vi.fn(() => new Promise<StorageCredentialsResponse>((resolve) => { release = resolve; }));
    const { resolver, createFs, createClient } = makeResolver(provider);

    const first = resolver.resolve(scope());
    const second = resolver.resolve(scope());
    expect(provider).toHaveBeenCalledTimes(1);

    release(credentials('storage-1'));
    const [firstClient, secondClient] = await Promise.all([first, second]);

    expect(firstClient).toBe(secondClient);
    expect(createFs).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledTimes(1);
    await expect(resolver.resolve(scope())).resolves.toBe(firstClient);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['serverUrl', { serverUrl: 'https://new.example.com' }],
    ['storageId', { storageId: 'storage-2' }],
    ['syncFolder', { syncFolder: 'Other' }],
    ['jwt', { jwt: 'jwt-2' }],
    ['userId', { userId: 'user-2' }],
    ['credentialGeneration', { credentialGeneration: 1 }],
  ] as const)('creates a new client when %s changes', async (_name, patch) => {
    const { resolver, provider, createClient } = makeResolver();

    const first = await resolver.resolve(scope());
    const second = await resolver.resolve(scope(patch));

    expect(second).not.toBe(first);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it('invalidates only the specified storage on 403-style invalidation', async () => {
    const { resolver, provider } = makeResolver();
    const first = await resolver.resolve(scope());
    const other = await resolver.resolve(scope({ storageId: 'storage-2' }));

    resolver.invalidate('storage-1');

    expect(await resolver.resolve(scope())).not.toBe(first);
    expect(await resolver.resolve(scope({ storageId: 'storage-2' }))).toBe(other);
    expect(provider).toHaveBeenCalledTimes(3);
  });

  it('clears every scope on 401 or session invalidation', async () => {
    const { resolver, provider } = makeResolver();
    const first = await resolver.resolve(scope());
    const other = await resolver.resolve(scope({ storageId: 'storage-2' }));

    resolver.invalidate();

    expect(await resolver.resolve(scope())).not.toBe(first);
    expect(await resolver.resolve(scope({ storageId: 'storage-2' }))).not.toBe(other);
    expect(provider).toHaveBeenCalledTimes(4);
  });

  it('does not let an invalidated in-flight request write back into the cache', async () => {
    let releaseFirst!: (value: StorageCredentialsResponse) => void;
    const provider = vi.fn()
      .mockImplementationOnce(() => new Promise<StorageCredentialsResponse>((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValueOnce(credentials('storage-1'));
    const { resolver } = makeResolver(provider);

    const stale = resolver.resolve(scope());
    resolver.invalidate('storage-1');
    const current = await resolver.resolve(scope());
    releaseFirst(credentials('storage-1'));
    const staleClient = await stale;

    expect(staleClient).not.toBe(current);
    await expect(resolver.resolve(scope())).resolves.toBe(current);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('removes a failed promise so the next call can retry', async () => {
    const provider = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(credentials('storage-1'));
    const { resolver } = makeResolver(provider);

    await expect(resolver.resolve(scope())).rejects.toThrow('temporary failure');
    await expect(resolver.resolve(scope())).resolves.toMatchObject({
      client: expect.any(DirectRepositoryClient),
      type: 'webdav',
    });
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('constructs filesystem options from the exact scope used to create the client', async () => {
    const provider = vi.fn(async (value: DirectRepositoryScope) => credentials(value.storageId));
    const createFs = vi.fn(() => fs);
    const optionsForScope = vi.fn(() => ({ onCredentialsChanged: vi.fn() }));
    const resolver = new DirectRepositoryResolver(provider, createFs, undefined, optionsForScope);
    const requestedScope = scope({ credentialGeneration: 7 });

    await resolver.resolve(requestedScope);

    expect(optionsForScope).toHaveBeenCalledWith(requestedScope);
    expect(createFs).toHaveBeenCalledWith(credentials('storage-1'), optionsForScope.mock.results[0].value);
  });

  it('rejects credentials whose storageId does not match the requested scope', async () => {
    const provider = vi.fn(async () => credentials('storage-2'));
    const { resolver, createFs, createClient } = makeResolver(provider);

    await expect(resolver.resolve(scope())).rejects.toThrow('storageId');
    expect(createFs).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });
});
