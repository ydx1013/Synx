import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type { RetentionPolicy } from '@synx/shared';
import type SynxSyncPlugin from './main.js';
import type { ConflictStrategy, SynxPluginSettings } from './settings.js';
import { WorkerApiError, WorkerClient } from './workerClient.js';

export class SynxSettingTab extends PluginSettingTab {
  private loginUser = '';
  private loginPass = '';

  constructor(app: App, private plugin: SynxSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.plugin.settings;
    containerEl.empty();
    this.renderServer(containerEl, settings);
    this.renderAccount(containerEl, settings);
    if (settings.jwt) this.renderStorage(containerEl, settings);
    this.renderAutomatic(containerEl, settings);
    this.renderFiltering(containerEl, settings);
    this.renderPerformance(containerEl, settings);
    this.renderConflicts(containerEl, settings);
    this.renderDeletionGuard(containerEl, settings);
    this.renderRetention(containerEl, settings);
    this.renderReports(containerEl, settings);
  }

  private renderServer(container: HTMLElement, settings: SynxPluginSettings): void {
    container.createEl('h3', { text: '服务器' });
    new Setting(container).setName('Server URL').setDesc(settings.serverUrl);
  }

  private renderAccount(container: HTMLElement, settings: SynxPluginSettings): void {
    container.createEl('h3', { text: '账号登录' });
    if (settings.jwt && settings.username) {
      new Setting(container).setName(`已登录：${settings.username}`).setDesc(`用户 ID: ${settings.userId ?? '-'}`).addButton((button) => button.setButtonText('登出').onClick(async () => {
        await this.applyPatch({ jwt: '', userId: null, username: null, storageId: null, storageName: null });
        this.display();
      }));
      return;
    }
    new Setting(container).setName('用户名 / 邮箱').addText((text) => text.setPlaceholder('alice 或 alice@example.com').onChange((value) => { this.loginUser = value.trim(); }));
    new Setting(container).setName('密码').addText((text) => {
      text.inputEl.type = 'password';
      text.onChange((value) => { this.loginPass = value; });
    });
    new Setting(container).addButton((button) => button.setButtonText('登录').onClick(async () => {
      if (!settings.serverUrl || !this.loginUser || !this.loginPass) {
        new Notice('请填写服务器 URL、用户名、密码');
        return;
      }
      try {
        const response = await WorkerClient.login(settings.serverUrl, this.loginUser, this.loginPass);
        await this.applyPatch({ jwt: response.token, userId: response.user.id, username: response.user.username });
        await this.plugin.onLogin();
        this.display();
      } catch (error) {
        this.showError('登录失败', error);
      }
    }));
  }

  private renderStorage(container: HTMLElement, settings: SynxPluginSettings): void {
    container.createEl('h3', { text: '存储选择' });
    new Setting(container).setName('主存储').setDesc(settings.storageName ?? '未选择').addDropdown(async (dropdown) => {
      try {
        const storages = await WorkerClient.listStorages(settings.serverUrl, settings.jwt);
        for (const storage of storages) dropdown.addOption(storage.id, `${storage.name} (${storage.type})`);
        if (settings.storageId) dropdown.setValue(settings.storageId);
        dropdown.onChange(async (id) => {
          const storage = storages.find((item) => item.id === id);
          // 切换主存储时，从备份列表中移除该存储（避免主备相同）
          const backupIds = settings.backupStorageIds.filter((bid) => bid !== id);
          await this.applyPatch({ storageId: id, storageName: storage?.name ?? null, backupStorageIds: backupIds });
          await this.plugin.onStorageChanged();
          this.display();
        });
      } catch (error) {
        this.showError('拉取存储列表失败', error);
      }
    });
    new Setting(container).setName('同步文件夹').setDesc('存储内的根路径').addText((text) => text.setValue(settings.syncFolder).onChange(async (value) => this.applyPatch({ syncFolder: value.trim() })));
    new Setting(container).setName('设备名').setDesc('用于冲突副本和版本历史').addText((text) => text.setValue(settings.deviceName).onChange(async (value) => this.applyPatch({ deviceName: value.trim() })));
    this.renderBackupStorages(container, settings);
  }

  /** 备份存储多选：主存储同步完成后，本地内容以仅 push 方式镜像到这些存储 */
  private renderBackupStorages(container: HTMLElement, settings: SynxPluginSettings): void {
    const desc = settings.backupStorageIds.length > 0
      ? `已选 ${settings.backupStorageIds.length} 个备份存储（仅推送，不拉取）`
      : '容灾镜像：主存储同步后，把本地内容推送到这些存储';
    const setting = new Setting(container).setName('备份存储').setDesc(desc);
    const descEl = setting.descEl;
    const listEl = descEl.createDiv({ cls: 'synx-backup-storage-list' });
    listEl.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-top:8px';
    void this.renderBackupStorageItems(listEl, settings);
  }

  private async renderBackupStorageItems(listEl: HTMLElement, settings: SynxPluginSettings): Promise<void> {
    listEl.empty();
    let storages: Awaited<ReturnType<typeof WorkerClient.listStorages>>;
    try {
      storages = await WorkerClient.listStorages(settings.serverUrl, settings.jwt);
    } catch (error) {
      listEl.createEl('div', { text: '拉取存储列表失败' });
      return;
    }
    // 备选存储 = 全部存储 - 主存储
    const candidates = storages.filter((s) => s.id !== settings.storageId);
    if (candidates.length === 0) {
      listEl.createEl('div', { text: '没有可选的备份存储（需先创建其他存储）' });
      return;
    }
    const selected = new Set(settings.backupStorageIds);
    for (const storage of candidates) {
      const row = listEl.createDiv({ cls: 'synx-backup-storage-item' });
      row.style.cssText = 'display:flex;align-items:center;gap:6px';
      const checkbox = row.createEl('input', { type: 'checkbox' });
      checkbox.checked = selected.has(storage.id);
      checkbox.onchange = async () => {
        const next = new Set(settings.backupStorageIds);
        if (checkbox.checked) next.add(storage.id);
        else next.delete(storage.id);
        await this.applyPatch({ backupStorageIds: [...next] });
      };
      row.createEl('span', { text: `${storage.name} (${storage.type})` });
    }
  }

  private renderAutomatic(container: HTMLElement, settings: SynxPluginSettings): void {
    container.createEl('h3', { text: '自动运行' });
    new Setting(container)
      .setName('定时自动同步')
      .setDesc('开启后按间隔自动同步（分钟）')
      .addToggle((toggle) => toggle.setValue(settings.periodicSyncEnabled).onChange(async (value) => this.applyPatch({ periodicSyncEnabled: value })))
      .addText((text) => {
        text.setPlaceholder('分钟').setValue(String(settings.autoSyncIntervalMin));
        text.inputEl.type = 'number';
        text.inputEl.min = '1';
        text.onChange(async (raw) => {
          const number = Number(raw);
          if (Number.isFinite(number) && number >= 1) await this.applyPatch({ autoSyncIntervalMin: number });
        });
      });
    new Setting(container)
      .setName('启动后自动同步')
      .setDesc('开启后在延迟时间后自动同步（秒）')
      .addToggle((toggle) => toggle.setValue(settings.startupSyncEnabled).onChange(async (value) => this.applyPatch({ startupSyncEnabled: value })))
      .addText((text) => {
        text.setPlaceholder('秒').setValue(String(settings.startupDelaySec));
        text.inputEl.type = 'number';
        text.inputEl.min = '0';
        text.onChange(async (raw) => {
          const number = Number(raw);
          if (Number.isFinite(number) && number >= 0) await this.applyPatch({ startupDelaySec: number });
        });
      });
    new Setting(container).setName('保存文件后同步').addDropdown((dropdown) => {
      [['0', '关闭'], ['5', '5 秒'], ['10', '10 秒'], ['30', '30 秒']].forEach(([value, label]) => dropdown.addOption(value, label));
      dropdown.setValue(String(settings.saveSyncDelaySec)).onChange(async (value) => this.applyPatch({ saveSyncDelaySec: Number(value) }));
    });
  }

  private renderFiltering(container: HTMLElement, settings: SynxPluginSettings): void {
    container.createEl('h3', { text: '文件过滤' });
    new Setting(container).setName('大文件限制').setDesc('在读取内容前跳过').addDropdown((dropdown) => {
      for (const value of [0, 1, 5, 10, 20, 50, 100, 200, 500, 1000]) dropdown.addOption(String(value), value === 0 ? '不限' : `${value} MB`);
      dropdown.setValue(String(settings.maxFileSizeMb)).onChange(async (value) => this.applyPatch({ maxFileSizeMb: Number(value) }));
    });
    new Setting(container).setName('同步 .obsidian 配置目录').setDesc('可能在设备间覆盖插件配置').addToggle((toggle) => toggle.setValue(settings.syncConfigDir).onChange((value) => {
      if (!value) void this.applyPatch({ syncConfigDir: false });
      else new ConfirmModal(this.app, '同步配置目录可能覆盖其他设备设置，确认开启？', () => void this.applyPatch({ syncConfigDir: true })).open();
    }));
    this.addToggle(container, '同步下划线路径', settings.syncUnderscorePaths, async (value) => this.applyPatch({ syncUnderscorePaths: value }));
    this.addRules(container, '忽略路径规则', settings.ignorePatterns, async (value) => this.applyPatch({ ignorePatterns: value }));
    this.addRules(container, '仅允许路径规则', settings.allowPatterns, async (value) => this.applyPatch({ allowPatterns: value }));
  }

  private renderPerformance(container: HTMLElement, settings: SynxPluginSettings): void {
    container.createEl('h3', { text: '性能' });
    new Setting(container).setName('并行度').setDesc('上传和下载共享任务池').addDropdown((dropdown) => {
      for (const value of [1, 2, 3, 5, 10]) dropdown.addOption(String(value), String(value));
      dropdown.setValue(String(settings.concurrency)).onChange(async (value) => this.applyPatch({ concurrency: Number(value) }));
    });
  }

  private renderConflicts(container: HTMLElement, settings: SynxPluginSettings): void {
    container.createEl('h3', { text: '冲突处理' });
    new Setting(container).setName('冲突策略').addDropdown((dropdown) => {
      dropdown.addOption('newer-with-copy', '较新优先并保留副本').addOption('keep-local', '始终保留本地').addOption('keep-remote', '始终保留远端').addOption('pause', '暂停并报告');
      dropdown.setValue(settings.conflictStrategy).onChange(async (value) => this.applyPatch({ conflictStrategy: value as ConflictStrategy }));
    });
  }

  private renderDeletionGuard(container: HTMLElement, settings: SynxPluginSettings): void {
    container.createEl('h3', { text: '删除保护' });
    // 骤降阈值百分比
    new Setting(container)
      .setName('本地文件骤降阈值')
      .setDesc('保护强度：阈值越高越敏感。当本地剩余文件数「低于」上次同步记录的该百分比时，视为批量丢失。例如 50% 表示本地文件减少过半才保护；设为 1% 表示几乎不保护（等于关闭）；设为 100% 表示少 1 个文件也保护')
      .addDropdown((dropdown) => {
        for (const value of [1, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
          const label = value === 1 ? '1%（关闭保护）' : value === 50 ? '50%（默认）' : value === 100 ? '100%（最严格）' : `${value}%`;
          dropdown.addOption(String(value), label);
        }
        dropdown.setValue(String(settings.massDeleteProtectPercent)).onChange(async (value) => this.applyPatch({ massDeleteProtectPercent: Number(value) }));
      });
    // 允许批量删除开关（一次性：重启后自动恢复关闭 → 触发保护时转 pull）
    new Setting(container)
      .setName('允许批量删除远端（一次性开关）')
      .setDesc('重启 Obsidian 后自动恢复关闭。打开：本次运行期间，保护触发（本地文件骤降）时也真正删除远端。关闭（默认）：保护触发时远端文件拉回本地、不删除')
      .addToggle((toggle) => toggle.setValue(settings.allowBatchRemoteDelete).onChange((value) => {
        if (value) {
          new ConfirmModal(this.app, '开启后，本次运行期间检测到本地文件骤降时，远端文件将被真正删除（重启后自动恢复关闭）。确认开启？', () => void this.applyPatch({ allowBatchRemoteDelete: true })).open();
        } else {
          void this.applyPatch({ allowBatchRemoteDelete: false });
        }
      }));
  }

  /** 版本保留策略：每层时间窗口内保留最新 1 份，保存到本地并上传远端（按 storage） */
  private renderRetention(container: HTMLElement, settings: SynxPluginSettings): void {
    container.createEl('h3', { text: '版本保留' });
    container.createEl('p', {
      text: '按时间分层保留版本：窗口内每个时间段保留最新 1 份，旧版本自动清理。设为 0 表示该层不保留。',
      cls: 'setting-item-description',
    });

    const fields: { key: keyof RetentionPolicy; label: string; desc: string }[] = [
      { key: 'hourlyWindowHours', label: '每小时', desc: '保留最近 N 小时内、每小时最新 1 份（例：24 = 最近 24 小时每小时 1 份）' },
      { key: 'dailyWindowDays', label: '每天', desc: '保留最近 N 天内、每天最新 1 份' },
      { key: 'monthlyWindowMonths', label: '每月', desc: '保留最近 N 个月内、每月最新 1 份' },
      { key: 'yearlyWindowYears', label: '每年', desc: '保留最近 N 年内、每年最新 1 份；超过 N 年自动删除' },
      { key: 'maxVersionsPerFile', label: '总版本上限', desc: '单文件最多保留的版本总数（兜底，0=不限）' },
    ];

    for (const field of fields) {
      new Setting(container).setName(field.label).setDesc(field.desc).addText((text) => {
        text.setValue(String(settings.retention[field.key]));
        text.inputEl.type = 'number';
        text.inputEl.min = '0';
        text.inputEl.max = '99999';
        text.onChange(async (value) => {
          const number = Number(value);
          if (!Number.isInteger(number) || number < 0) return;
          const next = { ...settings.retention, [field.key]: number };
          await this.applyPatch({ retention: next });
          await this.pushRetentionToRemote(next);
        });
      });
    }
  }

  /** 将保留策略上传到远端（已登录且有 storageId 时） */
  private async pushRetentionToRemote(policy: RetentionPolicy): Promise<void> {
    const client = this.plugin.getWorkerClient();
    if (!client || !this.plugin.settings.storageId) return;
    try {
      await client.setRetentionPolicy(policy);
    } catch (error) {
      this.showError('保存版本保留策略到服务器失败', error);
    }
  }

  private renderReports(container: HTMLElement, settings: SynxPluginSettings): void {
    container.createEl('h3', { text: '同步报告' });
    this.addToggle(container, '显示状态栏', settings.showStatusBar, async (value) => this.applyPatch({ showStatusBar: value }));
    new Setting(container).setName('保留报告数').setDesc('1-100，默认仅保留最近 1 份').addText((text) => text.setValue(String(settings.reportRetention)).onChange(async (value) => {
      const number = Number(value);
      if (Number.isInteger(number) && number >= 1 && number <= 100) await this.applyPatch({ reportRetention: number });
    }));
    this.addToggle(container, '显示笔记 UUID', settings.showMarkdownUuid, async (value) => this.applyPatch({ showMarkdownUuid: value }));
    new Setting(container).addButton((button) => button.setButtonText('打开版本历史').onClick(async () => this.plugin.activateHistoryPane())).addButton((button) => button.setButtonText('打开同步详情').onClick(async () => this.plugin.activateSyncDetails())).addButton((button) => button.setButtonText('立即同步').setCta().onClick(async () => this.plugin.triggerSync()));
  }

  private addToggle(container: HTMLElement, name: string, value: boolean, change: (value: boolean) => Promise<void>): void {
    new Setting(container).setName(name).addToggle((toggle) => toggle.setValue(value).onChange(change));
  }

  private addRules(container: HTMLElement, name: string, rules: string[], change: (rules: string[]) => Promise<void>): void {
    new Setting(container).setName(name).setDesc('每行一个路径或 glob').addTextArea((area) => area.setValue(rules.join('\n')).onChange(async (value) => change(value.split(/\r?\n/).map((rule) => rule.trim()).filter(Boolean))));
  }

  private async applyPatch(patch: Partial<SynxPluginSettings>): Promise<void> {
    await this.plugin.saveSettings(patch);
  }

  private showError(prefix: string, error: unknown): void {
    const message = error instanceof WorkerApiError ? `${error.status} ${error.message}` : (error as Error).message ?? String(error);
    new Notice(`${prefix}: ${message}`);
  }
}

export class ConfirmModal extends Modal {
  constructor(app: App, private message: string, private confirm: () => void) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl('p', { text: this.message });
    const buttons = this.contentEl.createDiv({ cls: 'synx-confirm-buttons' });
    buttons.createEl('button', { text: '取消' }).onclick = () => this.close();
    const ok = buttons.createEl('button', { text: '确认' });
    ok.addClass('mod-cta');
    ok.onclick = () => {
      this.confirm();
      this.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
