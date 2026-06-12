import type { WebSocket } from 'ws';
import type {
  ChatClientMsg,
  ChatEvent,
  ChatEventEnvelope,
  ChatServerControlMsg,
  SessionMeta,
  SessionStatus,
} from '@remotty/shared';
import type { EventLog } from './event-log.js';
import type { Logger } from '../logger.js';

/** Common surface used by ws.ts and SessionManager for every chat adapter. */
export interface ChatHandle {
  attach(ws: WebSocket, afterSeq: number): Promise<void>;
  detach(ws: WebSocket): void;
  handleClientMsg(msg: ChatClientMsg): void;
  dispose(): void;
}

export interface BaseChatDeps {
  meta: SessionMeta;
  log: EventLog;
  /** Persist meta (bumps updatedAt) — wired to the store via SessionManager. */
  onMetaChanged: (meta: SessionMeta) => void;
  logger: Logger;
}

/**
 * Shared WS plumbing for chat adapters: socket fan-out, lossless attach/replay
 * (per-socket buffer so live events emitted during the file read are neither
 * lost nor duplicated) and the single emit path seq → JSONL → broadcast.
 */
export abstract class BaseChatSession implements ChatHandle {
  protected readonly meta: SessionMeta;
  protected readonly log: EventLog;
  protected readonly onMetaChanged: (meta: SessionMeta) => void;
  protected readonly logger: Logger;

  private readonly sockets = new Set<WebSocket>();
  /** Sockets mid-replay buffer live events instead of receiving them out of order. */
  private readonly replaying = new Map<WebSocket, ChatEventEnvelope[]>();
  protected disposed = false;

  constructor(deps: BaseChatDeps) {
    this.meta = deps.meta;
    this.log = deps.log;
    this.onMetaChanged = deps.onMetaChanged;
    this.logger = deps.logger;
  }

  abstract handleClientMsg(msg: ChatClientMsg): void;
  abstract dispose(): void;

  async attach(ws: WebSocket, afterSeq: number): Promise<void> {
    const buffer: ChatEventEnvelope[] = [];
    this.sockets.add(ws);
    this.replaying.set(ws, buffer);
    try {
      const events = await this.log.readAfter(afterSeq);
      let maxSeq = afterSeq;
      for (const e of events) {
        this.sendTo(ws, JSON.stringify(e));
        if (e.seq > maxSeq) maxSeq = e.seq;
      }
      // Events emitted while we were reading the file:
      for (const e of buffer) {
        if (e.seq > maxSeq) this.sendTo(ws, JSON.stringify(e));
      }
      const attached: ChatServerControlMsg = {
        type: 'attached',
        lastSeq: this.log.lastSeq(),
        meta: this.meta,
      };
      this.sendTo(ws, JSON.stringify(attached));
    } catch (err) {
      this.logger.error('attach replay failed:', err);
    } finally {
      this.replaying.delete(ws);
    }
  }

  detach(ws: WebSocket): void {
    this.sockets.delete(ws);
    this.replaying.delete(ws);
  }

  protected closeAllSockets(): void {
    for (const ws of this.sockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.sockets.clear();
    this.replaying.clear();
  }

  /** Single emit path: assign seq, append to JSONL, broadcast to sockets. */
  protected emit(ev: ChatEvent): void {
    if (this.disposed) return;
    const envelope: ChatEventEnvelope = { seq: this.log.nextSeq(), ev };
    this.log.append(envelope);
    const data = JSON.stringify(envelope);
    for (const ws of this.sockets) {
      const buf = this.replaying.get(ws);
      if (buf) {
        buf.push(envelope);
        continue;
      }
      this.sendTo(ws, data);
    }
  }

  protected sendTo(ws: WebSocket, data: string): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(data);
    } catch (err) {
      this.logger.warn('ws send failed:', err);
    }
  }

  protected setStatus(status: SessionStatus): void {
    if (this.meta.status === status) return;
    this.meta.status = status;
    this.onMetaChanged(this.meta);
    this.emit({ type: 'status', status });
  }
}
