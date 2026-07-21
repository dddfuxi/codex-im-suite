import type { InboundMessage } from '../../../types.js';

/**
 * Feishu 入站队列只管理本地生命周期，不读取平台或 Store。
 * close() 必须丢弃旧任务并唤醒所有消费者，避免 adapter 停止后继续执行过期消息。
 */
export class FeishuInboundQueue {
  private openState = false;
  private readonly messages: InboundMessage[] = [];
  private waiters: Array<(message: InboundMessage | null) => void> = [];

  get size(): number {
    return this.messages.length;
  }

  open(): void {
    this.openState = true;
  }

  close(): void {
    this.openState = false;
    this.messages.length = 0;
    for (const waiter of this.waiters) waiter(null);
    this.waiters = [];
  }

  enqueue(message: InboundMessage): boolean {
    if (!this.openState) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter(message);
    else this.messages.push(message);
    return true;
  }

  consumeOne(waitForFuture = true): Promise<InboundMessage | null> {
    const queued = this.messages.shift();
    if (queued) return Promise.resolve(queued);
    if (!this.openState || !waitForFuture) return Promise.resolve(null);
    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  removeByMessageId(messageId: string): InboundMessage | null {
    const target = messageId.trim();
    if (!target) return null;
    const index = this.messages.findIndex((message) => message.messageId === target);
    if (index < 0) return null;
    const [removed] = this.messages.splice(index, 1);
    return removed || null;
  }
}
