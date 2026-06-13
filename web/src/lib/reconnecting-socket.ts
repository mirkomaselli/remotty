// WebSocket auto-riconnettente: backoff esponenziale con jitter (1s..15s) e
// riconnessione immediata su visibilitychange→visible / pageshow / online
// (i browser mobile uccidono i socket al blocco schermo: è la norma).

import type { ConnState } from '../store';
import { BASE_PATH } from './base-path';

interface Opts {
  url: string;
  binary?: boolean;
  onOpen: (ws: WebSocket) => void;
  onMessage: (data: string | ArrayBuffer) => void;
  onState: (s: ConnState) => void;
}

export class ReconnectingSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private opts: Opts) {
    this.connect();
    document.addEventListener('visibilitychange', this.wake);
    window.addEventListener('pageshow', this.wake);
    window.addEventListener('online', this.wake);
  }

  private wake = (): void => {
    if (this.stopped || document.visibilityState !== 'visible') return;
    const st = this.ws?.readyState;
    if (st === WebSocket.OPEN || st === WebSocket.CONNECTING) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.attempt = 0;
    this.connect();
  };

  private connect(): void {
    if (this.stopped) return;
    this.opts.onState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch {
      this.opts.onState('closed');
      this.scheduleReconnect();
      return;
    }
    if (this.opts.binary) ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.opts.onState('open');
      this.opts.onOpen(ws);
    };
    ws.onmessage = (e: MessageEvent<string | ArrayBuffer>) => this.opts.onMessage(e.data);
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.opts.onState('closed');
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer !== undefined) return;
    const cap = Math.min(15000, 1000 * 2 ** this.attempt);
    this.attempt++;
    const delay = cap / 2 + Math.random() * (cap / 2); // jitter 50–100% del cap
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, delay);
  }

  send(data: string | Uint8Array): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
      return true;
    }
    return false;
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Chiude il socket corrente forzando la riconnessione (es. pong mancato). */
  bounce(): void {
    this.ws?.close();
  }

  stop(): void {
    this.stopped = true;
    document.removeEventListener('visibilitychange', this.wake);
    window.removeEventListener('pageshow', this.wake);
    window.removeEventListener('online', this.wake);
    if (this.timer !== undefined) clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  }
}

export function wsBase(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${BASE_PATH}`;
}
