import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { TERM_OP } from '@remotty/shared';
import type { ChatClientMsg, SessionMeta, TermExitPayload } from '@remotty/shared';
import type { Auth } from './auth.js';
import type { SessionManager } from './session-manager.js';
import type { Store } from './store.js';
import { createLogger } from './logger.js';

const HEARTBEAT_MS = 25_000;
const WS_PATH = /^\/api\/sessions\/([^/]+)\/ws$/;

export function setupWebSocket(
  server: Server,
  deps: { auth: Auth; manager: SessionManager; store: Store },
): void {
  const { auth, manager, store } = deps;
  const logger = createLogger('ws');
  const wss = new WebSocketServer({ noServer: true });
  const alive = new WeakMap<WebSocket, boolean>();

  server.on('upgrade', (req, socket, head) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      const match = WS_PATH.exec(pathname);
      if (!match) {
        reject(socket, 404, 'Not Found');
        return;
      }
      if (!auth.authorizeUpgrade(req)) {
        reject(socket, 401, 'Unauthorized');
        return;
      }
      const meta = store.getSession(decodeURIComponent(match[1] ?? ''));
      if (!meta) {
        reject(socket, 404, 'Not Found');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        alive.set(ws, true);
        ws.on('pong', () => alive.set(ws, true));
        try {
          if (meta.kind === 'chat') attachChat(ws, meta);
          else attachTerminal(ws, meta);
        } catch (err) {
          logger.error(`attach ${meta.id} failed:`, err);
          try {
            ws.close();
          } catch {
            // ignore
          }
        }
      });
    } catch (err) {
      logger.error('upgrade failed:', err);
      socket.destroy();
    }
  });

  // Server-side keepalive: mobile browsers silently kill sockets on screen lock.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        // socket already dead
      }
    }
  }, HEARTBEAT_MS);
  server.on('close', () => clearInterval(heartbeat));

  function attachChat(ws: WebSocket, meta: SessionMeta): void {
    const session = manager.getOrCreateChat(meta);
    ws.on('message', (raw) => {
      let msg: ChatClientMsg;
      try {
        msg = JSON.parse(toBuffer(raw).toString('utf8')) as ChatClientMsg;
      } catch {
        logger.warn(`chat ${meta.id}: unparseable frame ignored`);
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
        return;
      }
      try {
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        if (msg.type === 'attach') {
          const afterSeq =
            typeof msg.afterSeq === 'number' && Number.isFinite(msg.afterSeq) && msg.afterSeq > 0
              ? Math.floor(msg.afterSeq)
              : 0;
          void session.attach(ws, afterSeq);
          return;
        }
        session.handleClientMsg(msg);
      } catch (err) {
        logger.error(`chat ${meta.id}: message handling failed:`, err);
      }
    });
    ws.on('close', () => session.detach(ws));
    ws.on('error', (err) => logger.warn(`chat ${meta.id}: socket error:`, err.message));
  }

  function attachTerminal(ws: WebSocket, meta: SessionMeta): void {
    ws.binaryType = 'nodebuffer';
    const term = manager.getTerminal(meta.id);
    if (!term) {
      // Server restarted: the pty and its ring buffer are gone. Tell the client
      // the terminal is dead instead of leaving it hanging.
      const exit: TermExitPayload = { exitCode: meta.exitCode ?? null };
      try {
        ws.send(Buffer.from([TERM_OP.SNAPSHOT]));
        ws.send(Buffer.concat([Buffer.from([TERM_OP.EXIT]), Buffer.from(JSON.stringify(exit), 'utf8')]));
      } catch {
        // ignore
      }
      return;
    }
    term.attach(ws);
    ws.on('message', (raw) => {
      try {
        term.handleMessage(toBuffer(raw));
      } catch (err) {
        logger.error(`term ${meta.id}: message handling failed:`, err);
      }
    });
    ws.on('close', () => term.detach(ws));
    ws.on('error', (err) => logger.warn(`term ${meta.id}: socket error:`, err.message));
  }
}

function toBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

function reject(socket: Duplex, code: number, text: string): void {
  try {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    // ignore
  }
  socket.destroy();
}
