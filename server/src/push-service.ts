import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import webpush from 'web-push';
import type {
  PushSubscriptionInput,
  SessionMeta,
} from '@remotty/shared';
import type { Logger } from './logger.js';

interface PushData {
  vapid: {
    publicKey: string;
    privateKey: string;
  };
  subscriptions: PushSubscriptionInput[];
}

export class PushService {
  private readonly file: string;
  private readonly data: PushData;
  private writeChain = Promise.resolve();

  constructor(dataDir: string, private readonly logger: Logger) {
    this.file = path.join(dataDir, 'push.json');
    this.data = this.load();
    webpush.setVapidDetails(
      'https://github.com/mirkomaselli/remotty',
      this.data.vapid.publicKey,
      this.data.vapid.privateKey,
    );
    if (!existsSync(this.file)) void this.save();
  }

  publicKey(): string {
    return this.data.vapid.publicKey;
  }

  subscribe(subscription: PushSubscriptionInput): void {
    validateSubscription(subscription);
    this.data.subscriptions = [
      subscription,
      ...this.data.subscriptions.filter((item) => item.endpoint !== subscription.endpoint),
    ];
    void this.save();
  }

  unsubscribe(endpoint: string): void {
    const next = this.data.subscriptions.filter((item) => item.endpoint !== endpoint);
    if (next.length === this.data.subscriptions.length) return;
    this.data.subscriptions = next;
    void this.save();
  }

  async notifyInputRequired(
    meta: SessionMeta,
    kind: 'permission' | 'question',
  ): Promise<void> {
    if (this.data.subscriptions.length === 0) return;
    const payload = JSON.stringify({
      title: 'Remotty needs your input',
      body:
        kind === 'permission'
          ? `${meta.title}: OpenCode is waiting for permission.`
          : `${meta.title}: OpenCode is waiting for an answer.`,
      url: `chat/${encodeURIComponent(meta.id)}`,
      tag: `remotty-input-${meta.id}`,
    });
    const expired = new Set<string>();
    await Promise.all(
      this.data.subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(subscription, payload, {
            TTL: 300,
            urgency: 'high',
            timeout: 10_000,
          });
        } catch (error) {
          const statusCode =
            error && typeof error === 'object' && 'statusCode' in error
              ? (error as { statusCode?: unknown }).statusCode
              : undefined;
          if (statusCode === 404 || statusCode === 410) {
            expired.add(subscription.endpoint);
            return;
          }
          this.logger.warn('push delivery failed:', error);
        }
      }),
    );
    if (expired.size > 0) {
      this.data.subscriptions = this.data.subscriptions.filter(
        (subscription) => !expired.has(subscription.endpoint),
      );
      void this.save();
    }
  }

  flushSync(): void {
    try {
      const tmp = `${this.file}.tmp-sync`;
      const json = JSON.stringify(this.data, null, 2);
      writeFileSync(tmp, json, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (error) {
      this.logger.error('push persistence flush failed:', error);
    }
  }

  private load(): PushData {
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PushData>;
        if (
          raw.vapid &&
          typeof raw.vapid.publicKey === 'string' &&
          typeof raw.vapid.privateKey === 'string'
        ) {
          return {
            vapid: raw.vapid,
            subscriptions: Array.isArray(raw.subscriptions)
              ? raw.subscriptions.filter(isSubscription)
              : [],
          };
        }
      } catch (error) {
        this.logger.warn('invalid push.json, generating new VAPID keys:', error);
      }
    }
    return {
      vapid: webpush.generateVAPIDKeys(),
      subscriptions: [],
    };
  }

  private save(): Promise<void> {
    const json = JSON.stringify(this.data, null, 2);
    this.writeChain = this.writeChain
      .then(async () => {
        const tmp = `${this.file}.tmp`;
        await fsp.writeFile(tmp, json, { encoding: 'utf8', mode: 0o600 });
        await fsp.rename(tmp, this.file);
      })
      .catch((error) => this.logger.error('push persistence failed:', error));
    return this.writeChain;
  }
}

function validateSubscription(value: PushSubscriptionInput): void {
  if (!isSubscription(value)) throw new Error('invalid push subscription');
}

function isSubscription(value: unknown): value is PushSubscriptionInput {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const keys = item['keys'];
  return (
    typeof item['endpoint'] === 'string' &&
    item['endpoint'].startsWith('https://') &&
    !!keys &&
    typeof keys === 'object' &&
    typeof (keys as Record<string, unknown>)['p256dh'] === 'string' &&
    typeof (keys as Record<string, unknown>)['auth'] === 'string'
  );
}
