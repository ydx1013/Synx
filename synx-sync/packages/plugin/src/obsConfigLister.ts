import type { Vault } from 'obsidian';
import type { LocalFile } from './syncAlgo.js';

/**
 * 列举 .obsidian/ 配置目录下的所有文件。
 *
 * 为什么需要单独的枚举器：
 * vault.getFiles() 不返回 .obsidian/ 内的文件（Obsidian 内部配置不在 vault 文件追踪范围）。
 * 必须用底层 vault.adapter.list() 递归遍历。
 *
 * 参考实现：remotely-save/src/obsFolderLister.ts
 */

/** .obsidian/ 内不应同步的文件名（同步会覆盖其他设备的工作区状态） */
const SKIP_FILENAMES = new Set(['workspace', 'workspace.json']);

/** 本插件目录内只同步这些标准文件 */
const PLUGIN_REQUIRED_FILES = new Set(['data.json', 'main.js', 'manifest.json', '.gitignore', 'styles.css']);

export interface ObsConfigListerOptions {
  /** 配置目录名，通常为 '.obsidian' */
  configDir: string;
  /** 当前插件 ID（用于跳过自身插件目录下的非标准文件） */
  pluginId: string;
}

export async function listObsConfigFiles(
  vault: Vault,
  opts: ObsConfigListerOptions,
): Promise<LocalFile[]> {
  const { configDir, pluginId } = opts;
  const results: LocalFile[] = [];
  const queue: string[] = [configDir];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const folder = queue.shift()!;
    if (visited.has(folder)) continue;
    visited.add(folder);

    let listed;
    try {
      listed = await vault.adapter.list(folder);
    } catch (error) {
      // .obsidian 可能不存在（移动端精简模式等），但必须让问题可见，
      // 否则移动端 .obsidian 同步会"神秘地"缺失且无任何日志（remotely-save 会抛错）。
      console.warn(`[synx] listObsConfigFiles: 无法枚举 ${folder}`, error instanceof Error ? error.message : String(error));
      continue;
    }

    for (const subFolder of listed.folders) {
      if (SKIP_FILENAMES.has(basename(subFolder))) continue;
      queue.push(subFolder);
    }

    for (const file of listed.files) {
      const name = basename(file);
      if (SKIP_FILENAMES.has(name)) continue;

      // 自身插件目录内只同步标准文件
      if (isInsidePluginDir(file, configDir, pluginId) && !PLUGIN_REQUIRED_FILES.has(name)) {
        continue;
      }

      const stat = await safeStat(vault, file);
      if (!stat) continue;
      results.push({
        path: file,
        mtime: stat.mtime > 0 ? stat.mtime : stat.ctime,
        size: stat.size,
      });
    }
  }

  return results;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function isInsidePluginDir(path: string, configDir: string, pluginId: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  const pluginPrefix = `${configDir}/plugins/${pluginId}`;
  return normalized === pluginPrefix || normalized.startsWith(`${pluginPrefix}/`);
}

async function safeStat(vault: Vault, path: string) {
  try {
    const stat = await vault.adapter.stat(path);
    if (!stat || stat.type !== 'file') {
      console.warn(`[synx] listObsConfigFiles: ${path} stat 非文件或缺失`, stat ?? 'stat=null');
      return null;
    }
    if (!Number.isFinite(stat.mtime) || stat.mtime <= 0) {
      // Obsidian 部分平台可能给 0，回退到 ctime
      if (!Number.isFinite(stat.ctime) || stat.ctime <= 0) {
        // 移动端部分文件 mtime/ctime 都为 0（remotely-save 对此直接抛错）。
        // 这里不静默丢弃，而是保留该文件（mtime 用 0，上层按"较旧"处理），
        // 避免 .obsidian 文件因 stat 元数据缺失而永远不参与同步。
        console.warn(`[synx] listObsConfigFiles: ${path} mtime/ctime 均为 0，保留文件`);
        return { ...stat, mtime: 0, ctime: 0 };
      }
    }
    return stat;
  } catch (error) {
    console.warn(`[synx] listObsConfigFiles: ${path} stat 失败`, error instanceof Error ? error.message : String(error));
    return null;
  }
}
