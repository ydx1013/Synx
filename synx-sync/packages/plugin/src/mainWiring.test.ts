// @vitest-environment node
import { describe, expect, it } from 'vitest';

const mainSource = await import('./main.ts' + '?raw').then((module) => module.default as string);
const actionsSource = await import('./pluginInventoryRuntime.ts' + '?raw').then((module) => module.default as string);

describe('main facade and authentication failure wiring', () => {
  it('keeps the storage credential facade method', () => {
    expect(mainSource).toMatch(/getStorageCredentials\(\): Promise<StorageCredentialsResponse \| null>/);
  });

  it('passes repository request scope through the selector callback', () => {
    expect(mainSource).toMatch(/new RepositoryTransportSelector\([\s\S]*?\(status, storageId, scope\) =>[\s\S]*?loginSessionFromRepositoryScope\(scope\)/);
  });

  it('does not re-handle captured action errors against current settings', () => {
    const start = actionsSource.indexOf('public async executeActions(');
    const end = actionsSource.indexOf('/** 报告收尾', start);
    const executeActions = actionsSource.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(executeActions).not.toContain('handleStorageAuthFailures');
    expect(executeActions).not.toContain('this.settings.storageId');
  });
});
