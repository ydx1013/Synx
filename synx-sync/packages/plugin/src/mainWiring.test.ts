// @vitest-environment node
import { describe, expect, it } from 'vitest';

const mainSource = await import('./main.ts' + '?raw').then((module) => module.default as string);
const inventorySource = await import('./pluginInventoryRuntime.ts' + '?raw').then((module) => module.default as string);
const actionsSource = await import('./pluginActionsRuntime.ts' + '?raw').then((module) => module.default as string);

describe('main facade and authentication failure wiring', () => {
  it('keeps the storage credential facade method', () => {
    expect(mainSource).toMatch(/getStorageCredentials\(\): Promise<StorageCredentialsResponse \| null>/);
  });

  it('passes repository request scope through the selector callback', () => {
    expect(mainSource).toMatch(/new RepositoryTransportSelector\([\s\S]*?\(status, storageId, scope\) =>[\s\S]*?loginSessionFromRepositoryScope\(scope\)/);
  });

  it('does not re-handle captured action errors against current settings', () => {
    const start = inventorySource.indexOf('public async executeActions(');
    const end = inventorySource.indexOf('/** 报告收尾', start);
    const executeActions = inventorySource.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(executeActions).not.toContain('handleStorageAuthFailures');
    expect(executeActions).not.toContain('this.settings.storageId');
  });

  it('writes files that exist outside the Vault index through the adapter', () => {
    const start = actionsSource.indexOf('public async writeLocal(');
    const end = actionsSource.indexOf('/** 写入 .obsidian/', start);
    const writeLocal = actionsSource.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(writeLocal).toContain('adapter.exists(path)');
    expect(writeLocal).toContain('adapter.writeBinary(path, content)');
  });

  it('does not recreate parent folders that exist outside the Vault index', () => {
    const start = actionsSource.indexOf('public async ensureParentDir(');
    const end = actionsSource.indexOf('/** 为 .obsidian/', start);
    const ensureParentDir = actionsSource.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(ensureParentDir).toContain('adapter.exists(current)');
    expect(ensureParentDir).toMatch(/if \(!indexed && !adapterExists\)/);
  });
});
