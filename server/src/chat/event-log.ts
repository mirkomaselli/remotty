import { existsSync, readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { ChatEventEnvelope } from '@remotty/shared';
import type { Logger } from '../logger.js';

/**
 * Append-only JSONL log for one chat session (data/chat/<id>.jsonl).
 * Appends are serialized through a per-file promise chain so concurrent emits
 * never interleave bytes; readAfter awaits the chain to see in-flight appends.
 */
export class EventLog {
  private chain: Promise<void> = Promise.resolve();
  private seq: number | null = null; // null until the file has been scanned

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
  ) {}

  lastSeq(): number {
    this.ensureScanned();
    return this.seq ?? 0;
  }

  nextSeq(): number {
    this.ensureScanned();
    this.seq = (this.seq ?? 0) + 1;
    return this.seq;
  }

  append(envelope: ChatEventEnvelope): void {
    const line = `${JSON.stringify(envelope)}\n`;
    this.chain = this.chain
      .then(() => fsp.appendFile(this.filePath, line, 'utf8'))
      .catch((err) => this.logger.error(`append failed (${this.filePath}):`, err));
  }

  async readAfter(afterSeq: number): Promise<ChatEventEnvelope[]> {
    this.ensureScanned();
    await this.chain;
    if (!existsSync(this.filePath)) return [];
    const out: ChatEventEnvelope[] = [];
    const text = await fsp.readFile(this.filePath, 'utf8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const env = JSON.parse(line) as ChatEventEnvelope;
        if (typeof env.seq === 'number' && env.seq > afterSeq) out.push(env);
      } catch {
        // torn tail line (crash mid-append) — skip
      }
    }
    return out;
  }

  async delete(): Promise<void> {
    await this.chain;
    this.seq = 0;
    await fsp.rm(this.filePath, { force: true });
  }

  /** Lines are appended in seq order, so the last parseable line carries the max seq. */
  private ensureScanned(): void {
    if (this.seq !== null) return;
    let max = 0;
    if (existsSync(this.filePath)) {
      try {
        const lines = readFileSync(this.filePath, 'utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i]?.trim();
          if (!line) continue;
          try {
            const env = JSON.parse(line) as ChatEventEnvelope;
            if (typeof env.seq === 'number') {
              max = env.seq;
              break;
            }
          } catch {
            continue; // torn line — look one line further back
          }
        }
      } catch (err) {
        this.logger.warn(`scan failed (${this.filePath}):`, err);
      }
    }
    this.seq = max;
  }
}
