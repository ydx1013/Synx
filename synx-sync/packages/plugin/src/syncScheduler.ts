import type { SyncTrigger } from './syncReport.js';

/** trigger() 的结果：'started' 本次立即执行；'queued' 已有同步在进行，已排队稍后自动执行 */
export type TriggerResult = 'started' | 'queued';

export interface SyncScheduleSettings {
  periodicSyncEnabled: boolean;
  autoSyncIntervalMin: number;
  startupSyncEnabled: boolean;
  startupDelaySec: number;
  saveSyncDelaySec: number;
}

export class SyncScheduler {
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private pending: SyncTrigger | null = null;
  private started = false;

  constructor(private settings: SyncScheduleSettings, private run: (trigger: SyncTrigger) => Promise<void>) {}

  start(): void {
    this.started = true;
    this.scheduleStartup();
    this.schedulePeriodic();
  }

  updateSettings(settings: SyncScheduleSettings): void {
    this.settings = settings;
    this.clearTimers();
    if (this.started) this.schedulePeriodic();
  }

  notifySave(): void {
    if (this.settings.saveSyncDelaySec <= 0) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.trigger('save');
    }, this.settings.saveSyncDelaySec * 1000);
  }

  async trigger(trigger: SyncTrigger): Promise<TriggerResult> {
    if (this.running) {
      // 已有同步在进行：新触发排队（合并），并让调用方知道「已排队」，以便给出 UI 反馈
      this.pending = trigger;
      return 'queued';
    }
    this.running = true;
    try {
      let next: SyncTrigger | null = trigger;
      while (next) {
        await this.run(next);
        next = this.pending;
        this.pending = null;
      }
      return 'started';
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    this.started = false;
    this.clearTimers();
    this.pending = null;
  }

  private scheduleStartup(): void {
    if (!this.settings.startupSyncEnabled) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.trigger('startup');
    }, this.settings.startupDelaySec * 1000);
  }

  private schedulePeriodic(): void {
    if (!this.settings.periodicSyncEnabled || this.settings.autoSyncIntervalMin <= 0) return;
    this.periodicTimer = setTimeout(async () => {
      this.periodicTimer = null;
      await this.trigger('timer');
      if (this.started) this.schedulePeriodic();
    }, this.settings.autoSyncIntervalMin * 60 * 1000);
  }

  private clearTimers(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.periodicTimer) clearTimeout(this.periodicTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.startupTimer = null;
    this.periodicTimer = null;
    this.saveTimer = null;
  }
}
