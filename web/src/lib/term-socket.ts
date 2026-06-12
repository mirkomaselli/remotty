// WS terminale: frame binari con opcode a 1 byte (stile ttyd), vedi TERM_OP.

import { TERM_OP } from '@remotty/shared';
import type { TermExitPayload } from '@remotty/shared';
import { ReconnectingSocket, wsBase } from './reconnecting-socket';
import type { ConnState } from '../store';

export type TermSocketEvent =
  | { type: 'conn'; state: ConnState }
  | { type: 'output'; data: Uint8Array }
  | { type: 'snapshot'; data: Uint8Array }
  | { type: 'exit'; exitCode: number | null };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function frame(op: number, payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(payload.length + 1);
  buf[0] = op;
  buf.set(payload, 1);
  return buf;
}

export class TermSocket {
  private sock: ReconnectingSocket;

  constructor(sessionId: string, onEvent: (e: TermSocketEvent) => void) {
    this.sock = new ReconnectingSocket({
      url: `${wsBase()}/api/sessions/${encodeURIComponent(sessionId)}/ws`,
      binary: true,
      onOpen: () => {
        /* il server invia SNAPSHOT subito dopo l'attach; la view manda RESIZE */
      },
      onMessage: (data) => {
        if (typeof data === 'string') return; // protocollo solo binario
        const bytes = new Uint8Array(data);
        if (bytes.length === 0) return;
        const op = bytes[0];
        const payload = bytes.subarray(1);
        switch (op) {
          case TERM_OP.OUTPUT:
            onEvent({ type: 'output', data: payload });
            break;
          case TERM_OP.SNAPSHOT:
            onEvent({ type: 'snapshot', data: payload });
            break;
          case TERM_OP.EXIT: {
            let exitCode: number | null = null;
            try {
              exitCode = (JSON.parse(decoder.decode(payload)) as TermExitPayload).exitCode;
            } catch {
              /* payload malformato: exitCode resta null */
            }
            onEvent({ type: 'exit', exitCode });
            break;
          }
        }
      },
      onState: (state) => onEvent({ type: 'conn', state }),
    });
  }

  input(text: string): boolean {
    return this.sock.send(frame(TERM_OP.INPUT, encoder.encode(text)));
  }

  resize(cols: number, rows: number): boolean {
    return this.sock.send(
      frame(TERM_OP.RESIZE, encoder.encode(JSON.stringify({ cols, rows }))),
    );
  }

  get open(): boolean {
    return this.sock.open;
  }

  close(): void {
    this.sock.stop();
  }
}
