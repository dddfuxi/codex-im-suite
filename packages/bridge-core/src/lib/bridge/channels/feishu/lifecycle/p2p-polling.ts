export interface FeishuP2pPollState {
  state: 'polling' | 'idle' | 'failed';
  at: string;
  error?: string;
}

export interface FeishuP2pPollingOptions {
  intervalMs: number;
  poll: () => Promise<void>;
  scheduleInterval?: (callback: () => void, intervalMs: number) => unknown;
  clearScheduledInterval?: (handle: unknown) => void;
  now?: () => string;
  onState?: (state: FeishuP2pPollState) => void;
}

/**
 * 管理 P2P 补捞的本地调度生命周期，不读取平台、文件或审计 Store。
 * activeRun 跨 stop/start 保留，确保旧轮询未结束时新调度不会重叠执行。
 */
export class FeishuP2pPollingLifecycle {
  private openState = false;
  private generation = 0;
  private intervalHandle: unknown = null;
  private activeRun: Promise<void> | null = null;

  constructor(private readonly options: FeishuP2pPollingOptions) {}

  start(): void {
    this.stop();
    this.openState = true;
    this.generation += 1;
    void this.pollNow();
    const schedule = this.options.scheduleInterval
      || ((callback: () => void, intervalMs: number) => setInterval(callback, intervalMs));
    this.intervalHandle = schedule(() => { void this.pollNow(); }, this.options.intervalMs);
  }

  stop(): void {
    this.openState = false;
    this.generation += 1;
    if (this.intervalHandle !== null) {
      const clear = this.options.clearScheduledInterval
        || ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
      clear(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  async pollNow(): Promise<boolean> {
    if (!this.openState || this.activeRun) return false;
    const generation = this.generation;
    const now = this.options.now || (() => new Date().toISOString());
    const isCurrent = () => this.openState && this.generation === generation;
    const run = (async () => {
      if (isCurrent()) this.options.onState?.({ state: 'polling', at: now() });
      try {
        await this.options.poll();
        if (isCurrent()) this.options.onState?.({ state: 'idle', at: now() });
      } catch (error) {
        if (isCurrent()) {
          this.options.onState?.({
            state: 'failed',
            at: now(),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    let tracked!: Promise<void>;
    tracked = run.finally(() => {
      if (this.activeRun === tracked) this.activeRun = null;
    });
    this.activeRun = tracked;
    return true;
  }

  async whenIdle(): Promise<void> {
    await this.activeRun;
  }
}

export interface FeishuP2pRecoveryMessage {
  message_id: string;
  chat_id: string;
  create_time: string;
  msg_type: string;
  deleted?: boolean;
  sender?: unknown;
}

export interface FeishuP2pRecoverySelectionOptions<T extends FeishuP2pRecoveryMessage> {
  latestKnownTime: number;
  isFromSelf: (item: T) => boolean;
  isSeen: (messageId: string) => boolean;
}

export function selectFeishuP2pRecoveryCandidates<T extends FeishuP2pRecoveryMessage>(
  items: T[],
  options: FeishuP2pRecoverySelectionOptions<T>,
): T[] {
  return items
    .filter((item) => !item.deleted)
    .filter((item) => item.msg_type !== 'system')
    .filter((item) => !options.isFromSelf(item))
    .filter((item) => !options.isSeen(item.message_id))
    .filter((item) => (Number.parseInt(item.create_time, 10) || 0) > options.latestKnownTime)
    .sort((left, right) => (Number.parseInt(left.create_time, 10) || 0) - (Number.parseInt(right.create_time, 10) || 0));
}
