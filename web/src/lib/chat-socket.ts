// WS chat: frame JSON testuali. All'apertura invia attach con l'ultimo seq
// visto, così il server fa replay lossless dal log JSONL.

import { isChatEnvelope } from '@remotty/shared';
import type {
  ChatClientMsg,
  ChatEventEnvelope,
  ChatServerMsg,
  SessionMeta,
} from '@remotty/shared';
import { ReconnectingSocket, wsBase } from './reconnecting-socket';
import type { ConnState } from '../store';

export type ChatSocketEvent =
  | { type: 'conn'; state: ConnState }
  | { type: 'envelope'; env: ChatEventEnvelope }
  | { type: 'attached'; lastSeq: number; meta: SessionMeta };

const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;

export class ChatSocket {
  private sock: ReconnectingSocket;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongWatch: ReturnType<typeof setTimeout> | undefined;

  constructor(
    sessionId: string,
    getAfterSeq: () => number,
    onEvent: (e: ChatSocketEvent) => void,
  ) {
    this.sock = new ReconnectingSocket({
      url: `${wsBase()}/api/sessions/${encodeURIComponent(sessionId)}/ws`,
      onOpen: () => {
        this.send({ type: 'attach', afterSeq: getAfterSeq() });
        this.startPing();
      },
      onMessage: (data) => {
        if (typeof data !== 'string') return;
        let msg: ChatServerMsg;
        try {
          msg = JSON.parse(data) as ChatServerMsg;
        } catch {
          return;
        }
        if (isChatEnvelope(msg)) {
          onEvent({ type: 'envelope', env: msg });
          return;
        }
        if (msg.type === 'pong') {
          if (this.pongWatch !== undefined) clearTimeout(this.pongWatch);
          this.pongWatch = undefined;
          return;
        }
        if (msg.type === 'attached') {
          onEvent({ type: 'attached', lastSeq: msg.lastSeq, meta: msg.meta });
        }
      },
      onState: (state) => {
        if (state !== 'open') this.stopPing();
        onEvent({ type: 'conn', state });
      },
    });
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.send({ type: 'ping' })) return;
      if (this.pongWatch === undefined) {
        this.pongWatch = setTimeout(() => {
          // Nessun pong: il socket è morto in silenzio (tipico dopo lock schermo).
          this.pongWatch = undefined;
          this.sock.bounce();
        }, PONG_TIMEOUT_MS);
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    if (this.pongWatch !== undefined) clearTimeout(this.pongWatch);
    this.pingTimer = undefined;
    this.pongWatch = undefined;
  }

  send(msg: ChatClientMsg): boolean {
    return this.sock.send(JSON.stringify(msg));
  }

  userMessage(text: string): boolean {
    return this.send({ type: 'user_message', text });
  }

  permissionResponse(
    requestId: string,
    behavior: 'allow' | 'deny',
    extra?: { message?: string; updatedInput?: unknown; updatedPermissions?: unknown[] },
  ): boolean {
    return this.send({ type: 'permission_response', requestId, behavior, ...extra });
  }

  interrupt(): boolean {
    return this.send({ type: 'interrupt' });
  }

  setModel(model: string | null): boolean {
    return this.send({ type: 'set_model', model });
  }

  setVariant(variant: string | null): boolean {
    return this.send({ type: 'set_variant', variant });
  }

  clearContext(): boolean {
    return this.send({ type: 'clear_context' });
  }

  compactContext(): boolean {
    return this.send({ type: 'compact_context' });
  }

  close(): void {
    this.stopPing();
    this.sock.stop();
  }
}
