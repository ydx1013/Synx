import type { SynxPluginSettings } from './settings.js';

type FilterSettings = Pick<SynxPluginSettings, 'syncConfigDir' | 'syncUnderscorePaths' | 'maxFileSizeMb' | 'ignorePatterns' | 'allowPatterns'>;

export type FileFilterResult = { sync: true } | { sync: false; reason: string; rule: string; size: number };

export function evaluateFile(path: string, size: number, settings: FilterSettings): FileFilterResult {
  const normalized = normalizePath(path);
  if (matchesGlob(normalized, '.trash/**')) return skipped('回收站路径不参与同步', '.trash/**', size);
  if (matchesGlob(normalized, '.synx-ignore/**') || normalized === '.synx-ignore') return skipped('Synx 忽略标记路径', '.synx-ignore/**', size);
  if (matchesGlob(normalized, '.synx-conflicts/**') || normalized === '.synx-conflicts') return skipped('Synx 冲突副本不参与同步', '.synx-conflicts/**', size);
  // workspace / workspace.json 是设备工作区状态，同步会互相覆盖
  if (normalized === '.obsidian/workspace' || normalized === '.obsidian/workspace.json') {
    return skipped('工作区状态不参与同步', '.obsidian/workspace*', size);
  }
  // synx 运行时状态文件（reports/pendingDeletions 等），永不同步
  if (normalized === '.obsidian/plugins/synx-sync/synx-state.json') {
    return skipped('Synx 运行时状态不参与同步', 'synx-state.json', size);
  }
  // synx 自身 data.json 含每设备不同的登录态/设备名（jwt、deviceName、storageId 等），
  // 跨设备同步会互相覆盖登录信息并造成"本地新→push→远端新→pull"的抖动，不参与同步。
  if (normalized === '.obsidian/plugins/synx-sync/data.json') {
    return skipped('Synx 自身配置不参与同步（每设备独立）', 'synx-sync/data.json', size);
  }
  // 诊断日志写在 vault 根目录（iOS 上只显示 .md 文件，必须用 .md 后缀），
  // 该文件必须被排除，否则会被同步到远端。旧版 .log 同名文件也一并排除。
  if (normalized === 'synx-debug.md' || normalized === 'synx-debug.log') {
    return skipped('Synx 诊断日志不参与同步', 'synx-debug.*', size);
  }
  if (!settings.syncConfigDir && (normalized === '.obsidian' || matchesGlob(normalized, '.obsidian/**'))) return skipped('配置目录同步已关闭', '.obsidian/**', size);
  if (!settings.syncUnderscorePaths && normalized.split('/').some((segment) => segment.startsWith('_'))) return skipped('下划线路径同步已关闭', '_*', size);
  if (settings.maxFileSizeMb > 0 && size > settings.maxFileSizeMb * 1024 * 1024) {
    return skipped(`文件超过 ${settings.maxFileSizeMb} MB 限制`, `size>${settings.maxFileSizeMb}MB`, size);
  }
  const ignoredBy = settings.ignorePatterns.find((pattern) => matchesGlob(normalized, pattern));
  if (ignoredBy) return skipped('命中忽略路径规则', ignoredBy, size);
  if (settings.allowPatterns.length > 0 && !settings.allowPatterns.some((pattern) => matchesGlob(normalized, pattern))) {
    return skipped('未命中允许路径规则', 'allowlist', size);
  }
  return { sync: true };
}

function skipped(reason: string, rule: string, size: number): FileFilterResult {
  return { sync: false, reason, rule, size };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
}

function matchesGlob(path: string, pattern: string): boolean {
  const normalized = normalizePath(pattern);
  const regex = normalized.split('').reduce((source, char, index) => {
    if (char === '*' && normalized[index + 1] === '*') return source + '.*';
    if (char === '*' && normalized[index - 1] === '*') return source;
    if (char === '*') return source + '[^/]*';
    if (char === '?') return source + '[^/]';
    return source + escapeRegex(char);
  }, '');
  const basenamePattern = !normalized.includes('/');
  return new RegExp(basenamePattern ? `(?:^|/)${regex}$` : `^${regex}$`).test(path);
}

function escapeRegex(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}
