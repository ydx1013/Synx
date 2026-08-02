import { describe, expect, it } from 'vitest';
import { evaluateFile } from './fileFilter.js';
import type { SynxPluginSettings } from './settings.js';

const base = {
  syncConfigDir: false,
  syncUnderscorePaths: false,
  maxFileSizeMb: 20,
  ignorePatterns: [],
  allowPatterns: [],
} satisfies Pick<SynxPluginSettings, 'syncConfigDir' | 'syncUnderscorePaths' | 'maxFileSizeMb' | 'ignorePatterns' | 'allowPatterns'>;

describe('evaluateFile', () => {
  it('skips built-in trash and marker paths', () => {
    expect(evaluateFile('.trash/a.md', 1, base)).toMatchObject({ sync: false, rule: '.trash/**' });
    expect(evaluateFile('.synx-ignore/a.md', 1, base)).toMatchObject({ sync: false, rule: '.synx-ignore/**' });
    expect(evaluateFile('.synx-conflicts/a.md', 1, base)).toMatchObject({ sync: false, rule: '.synx-conflicts/**' });
  });

  it('skips config and underscore path segments unless enabled', () => {
    expect(evaluateFile('.obsidian/plugins/x.json', 1, base)).toMatchObject({ sync: false, rule: '.obsidian/**' });
    expect(evaluateFile('notes/_private/a.md', 1, base)).toMatchObject({ sync: false, rule: '_*' });
    expect(evaluateFile('_draft.md', 1, { ...base, syncConfigDir: true, syncUnderscorePaths: true })).toEqual({ sync: true });
  });

  it('always skips synx runtime state and vault-root debug log', () => {
    // synx-state.json 永不同步
    expect(evaluateFile('.obsidian/plugins/synx-sync/synx-state.json', 1, base)).toMatchObject({ sync: false, rule: 'synx-state.json' });
    // 诊断日志写在 vault 根目录（iOS 可见，必须 .md 后缀），同样必须排除，避免同步到远端
    expect(evaluateFile('synx-debug.md', 1, base)).toMatchObject({ sync: false, rule: 'synx-debug.*' });
    expect(evaluateFile('synx-debug.md', 1, { ...base, syncConfigDir: true })).toMatchObject({ sync: false });
    // 旧版 .log 后缀也排除（v0.1.8 曾写入 synx-debug.log）
    expect(evaluateFile('synx-debug.log', 1, base)).toMatchObject({ sync: false, rule: 'synx-debug.*' });
  });

  it('always skips .obsidian/workspace and workspace.json regardless of syncConfigDir', () => {
    // 工作区状态文件即使开启同步配置目录也不应同步（避免覆盖其他设备的工作区）
    const settings = { ...base, syncConfigDir: true };
    expect(evaluateFile('.obsidian/workspace', 1, settings)).toMatchObject({ sync: false, rule: '.obsidian/workspace*' });
    expect(evaluateFile('.obsidian/workspace.json', 1, settings)).toMatchObject({ sync: false, rule: '.obsidian/workspace*' });
    // 其他 .obsidian 配置文件应正常通过
    expect(evaluateFile('.obsidian/app.json', 1, settings)).toEqual({ sync: true });
    expect(evaluateFile('.obsidian/plugins/synx-sync/main.js', 1, settings)).toEqual({ sync: true });
  });

  it('skips oversized files and reports size before content is read', () => {
    expect(evaluateFile('video.bin', 20 * 1024 * 1024 + 1, base)).toEqual({
      sync: false,
      reason: '文件超过 20 MB 限制',
      rule: 'size>20MB',
      size: 20 * 1024 * 1024 + 1,
    });
  });

  it('applies ignore globs and allowlist globs', () => {
    const settings = { ...base, ignorePatterns: ['tmp/**', '*.bak'], allowPatterns: ['notes/**'] };
    expect(evaluateFile('notes/tmp/a.md', 1, settings)).toMatchObject({ sync: true });
    expect(evaluateFile('notes/a.bak', 1, settings)).toMatchObject({ sync: false, rule: '*.bak' });
    expect(evaluateFile('assets/a.png', 1, settings)).toMatchObject({ sync: false, rule: 'allowlist' });
  });

  it('normalizes separators and supports globstar', () => {
    expect(evaluateFile('notes\\daily\\2026.md', 1, { ...base, allowPatterns: ['notes/**'] })).toEqual({ sync: true });
  });
});
