import { describe, expect, it, vi } from 'vitest';
import type { ListedFiles, Stat, Vault } from 'obsidian';
import { listObsConfigFiles } from './obsConfigLister.js';

function makeVault(tree: Record<string, ListedFiles>, stats: Record<string, Stat>): Vault {
  return {
    adapter: {
      list: vi.fn(async (path: string) => tree[path] ?? { files: [], folders: [] }),
      stat: vi.fn(async (path: string) => stats[path] ?? null),
    },
  } as unknown as Vault;
}

describe('listObsConfigFiles', () => {
  it('recursively lists files in .obsidian directory', async () => {
    const vault = makeVault(
      {
        '.obsidian': { files: ['.obsidian/app.json', '.obsidian/workspace.json'], folders: ['.obsidian/plugins'] },
        '.obsidian/plugins': { files: [], folders: ['.obsidian/plugins/synx-sync', '.obsidian/plugins/other'] },
        '.obsidian/plugins/synx-sync': {
          files: ['.obsidian/plugins/synx-sync/main.js', '.obsidian/plugins/synx-sync/data.json', '.obsidian/plugins/synx-sync/bridge.log'],
          folders: [],
        },
        '.obsidian/plugins/other': {
          files: ['.obsidian/plugins/other/main.js', '.obsidian/plugins/other/data.json'],
          folders: [],
        },
      },
      {
        '.obsidian/app.json': { type: 'file', ctime: 1000, mtime: 2000, size: 50 },
        '.obsidian/workspace.json': { type: 'file', ctime: 1000, mtime: 2000, size: 200 },
        '.obsidian/plugins/synx-sync/main.js': { type: 'file', ctime: 1000, mtime: 3000, size: 1000 },
        '.obsidian/plugins/synx-sync/data.json': { type: 'file', ctime: 1000, mtime: 4000, size: 20 },
        '.obsidian/plugins/synx-sync/bridge.log': { type: 'file', ctime: 1000, mtime: 5000, size: 999 },
        '.obsidian/plugins/other/main.js': { type: 'file', ctime: 1000, mtime: 6000, size: 2000 },
        '.obsidian/plugins/other/data.json': { type: 'file', ctime: 1000, mtime: 7000, size: 30 },
      },
    );

    const result = await listObsConfigFiles(vault, { configDir: '.obsidian', pluginId: 'synx-sync' });

    const paths = result.map((f) => f.path).sort();
    // workspace.json 必须被跳过；自身插件目录内非标准文件 (bridge.log) 必须被跳过
    expect(paths).toEqual([
      '.obsidian/app.json',
      '.obsidian/plugins/other/data.json',
      '.obsidian/plugins/other/main.js',
      '.obsidian/plugins/synx-sync/data.json',
      '.obsidian/plugins/synx-sync/main.js',
    ]);
    // mtime 回退到 ctime 的逻辑
    const appJson = result.find((f) => f.path === '.obsidian/app.json');
    expect(appJson).toMatchObject({ mtime: 2000, size: 50 });
  });

  it('skips workspace and workspace.json files', async () => {
    const vault = makeVault(
      {
        '.obsidian': { files: ['.obsidian/workspace', '.obsidian/workspace.json', '.obsidian/app.json'], folders: [] },
      },
      {
        '.obsidian/workspace': { type: 'file', ctime: 1000, mtime: 2000, size: 100 },
        '.obsidian/workspace.json': { type: 'file', ctime: 1000, mtime: 2000, size: 200 },
        '.obsidian/app.json': { type: 'file', ctime: 1000, mtime: 3000, size: 50 },
      },
    );

    const result = await listObsConfigFiles(vault, { configDir: '.obsidian', pluginId: 'synx-sync' });
    expect(result.map((f) => f.path)).toEqual(['.obsidian/app.json']);
  });

  it('falls back to ctime when mtime is 0', async () => {
    const vault = makeVault(
      { '.obsidian': { files: ['.obsidian/app.json'], folders: [] } },
      { '.obsidian/app.json': { type: 'file', ctime: 5000, mtime: 0, size: 50 } },
    );

    const result = await listObsConfigFiles(vault, { configDir: '.obsidian', pluginId: 'synx-sync' });
    expect(result[0].mtime).toBe(5000);
  });

  it('returns empty when .obsidian does not exist', async () => {
    const vault = makeVault({}, {});
    const result = await listObsConfigFiles(vault, { configDir: '.obsidian', pluginId: 'synx-sync' });
    expect(result).toEqual([]);
  });

  it('only syncs standard files inside own plugin dir', async () => {
    const vault = makeVault(
      {
        '.obsidian': { files: [], folders: ['.obsidian/plugins'] },
        '.obsidian/plugins': { files: [], folders: ['.obsidian/plugins/synx-sync'] },
        '.obsidian/plugins/synx-sync': {
          files: ['.obsidian/plugins/synx-sync/main.js', '.obsidian/plugins/synx-sync/manifest.json', '.obsidian/plugins/synx-sync/styles.css', '.obsidian/plugins/synx-sync/.gitignore', '.obsidian/plugins/synx-sync/cache.db'],
          folders: [],
        },
      },
      {
        '.obsidian/plugins/synx-sync/main.js': { type: 'file', ctime: 1000, mtime: 1000, size: 100 },
        '.obsidian/plugins/synx-sync/manifest.json': { type: 'file', ctime: 1000, mtime: 1000, size: 100 },
        '.obsidian/plugins/synx-sync/styles.css': { type: 'file', ctime: 1000, mtime: 1000, size: 100 },
        '.obsidian/plugins/synx-sync/.gitignore': { type: 'file', ctime: 1000, mtime: 1000, size: 100 },
        '.obsidian/plugins/synx-sync/cache.db': { type: 'file', ctime: 1000, mtime: 1000, size: 100 },
      },
    );

    const result = await listObsConfigFiles(vault, { configDir: '.obsidian', pluginId: 'synx-sync' });
    const paths = result.map((f) => f.path).sort();
    expect(paths).toEqual([
      '.obsidian/plugins/synx-sync/.gitignore',
      '.obsidian/plugins/synx-sync/main.js',
      '.obsidian/plugins/synx-sync/manifest.json',
      '.obsidian/plugins/synx-sync/styles.css',
    ]);
    // cache.db 是非标准文件，必须被跳过
    expect(paths).not.toContain('.obsidian/plugins/synx-sync/cache.db');
  });
});
