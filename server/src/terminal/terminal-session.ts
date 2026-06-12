import { spawn } from '@lydell/node-pty';
import type { IPty } from '@lydell/node-pty';
import type { WebSocket } from 'ws';
import { TERM_OP } from '@remotty/shared';
import type { SessionMeta, TermExitPayload, TermResizePayload } from '@remotty/shared';
import type { Logger } from '../logger.js';

const RING_MAX_BYTES = 2 * 1024 * 1024;
const HIGH_WATER = 1024 * 1024; // pause pty above this bufferedAmount on any socket
const LOW_WATER = 256 * 1024; // resume once ALL sockets are below this
const FLOW_CHECK_MS = 500;
const RESIZE_DEBOUNCE_MS = 250;

/**
 * One PTY (ConPTY on Windows, forkpty elsewhere) fanned out to N web sockets
 * with a 2 MB replay ring buffer. Binary ttyd-style framing (see TERM_OP).
 */
export class TerminalSession {
  private readonly pty: IPty;
  private readonly sockets = new Set<WebSocket>();
  private readonly ring: Buffer[] = [];
  private ringBytes = 0;
  private exited = false;
  private exitCode: number | null = null;
  private paused = false;
  private flowTimer: NodeJS.Timeout | null = null;
  private resizeTimer: NodeJS.Timeout | null = null;
  private pendingResize: TermResizePayload | null = null;

  constructor(
    private readonly meta: SessionMeta,
    private readonly onMetaChanged: (meta: SessionMeta) => void,
    private readonly logger: Logger,
  ) {
    const { file, args } = resolveCommand(meta.command);
    this.pty = spawn(file, args, {
      cwd: meta.cwd,
      cols: 100,
      rows: 30,
      name: 'xterm-256color',
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      } as { [key: string]: string },
    });
    meta.status = 'running';
    meta.exitCode = null;
    onMetaChanged(meta);
    this.pty.onData((data) => this.handleData(data));
    this.pty.onExit(({ exitCode }) => this.handleExit(exitCode));
    this.logger.info(`spawned ${file} ${args.join(' ')} (pid ${this.pty.pid}) in ${meta.cwd}`);
  }

  attach(ws: WebSocket): void {
    this.sockets.add(ws);
    try {
      // Snapshot first, then live output. Partial escape sequences at the ring
      // boundary are acceptable v1.
      ws.send(Buffer.concat([Buffer.from([TERM_OP.SNAPSHOT]), ...this.ring]));
      if (this.exited) ws.send(this.exitFrame());
    } catch (err) {
      this.logger.warn('snapshot send failed:', err);
    }
  }

  detach(ws: WebSocket): void {
    this.sockets.delete(ws);
    // A slow socket leaving may unblock flow control.
    if (this.paused) this.maybeResume();
  }

  handleMessage(data: Buffer): void {
    if (data.length === 0) return;
    const op = data[0];
    if (op === TERM_OP.INPUT) {
      if (this.exited) return;
      try {
        this.pty.write(data.subarray(1).toString('utf8'));
      } catch (err) {
        this.logger.warn('pty write failed:', err);
      }
    } else if (op === TERM_OP.RESIZE) {
      let payload: unknown;
      try {
        payload = JSON.parse(data.subarray(1).toString('utf8'));
      } catch {
        return; // malformed resize — ignore
      }
      const { cols, rows } = payload as Partial<TermResizePayload>;
      if (
        typeof cols !== 'number' ||
        typeof rows !== 'number' ||
        !Number.isInteger(cols) ||
        !Number.isInteger(rows) ||
        cols < 2 ||
        cols > 500 ||
        rows < 2 ||
        rows > 500
      ) {
        return;
      }
      this.pendingResize = { cols, rows };
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.resizeTimer = null;
        const r = this.pendingResize;
        this.pendingResize = null;
        if (!r || this.exited) return;
        try {
          this.pty.resize(r.cols, r.rows);
        } catch (err) {
          this.logger.warn('resize failed:', err);
        }
      }, RESIZE_DEBOUNCE_MS);
    }
  }

  kill(): void {
    this.clearTimers();
    if (!this.exited) {
      try {
        this.pty.kill();
      } catch (err) {
        this.logger.warn('kill failed:', err);
      }
    }
  }

  // ===== internals ===========================================================

  private handleData(data: string): void {
    const buf = Buffer.from(data, 'utf8');
    this.ring.push(buf);
    this.ringBytes += buf.length;
    while (this.ringBytes > RING_MAX_BYTES && this.ring.length > 1) {
      const dropped = this.ring.shift();
      if (!dropped) break;
      this.ringBytes -= dropped.length;
    }
    const frame = Buffer.concat([Buffer.from([TERM_OP.OUTPUT]), buf]);
    for (const ws of this.sockets) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(frame);
        } catch (err) {
          this.logger.warn('output send failed:', err);
        }
      }
    }
    this.checkBackpressure();
  }

  private handleExit(exitCode: number): void {
    this.exited = true;
    this.exitCode = exitCode;
    this.clearTimers();
    this.meta.status = 'exited';
    this.meta.exitCode = exitCode;
    this.onMetaChanged(this.meta);
    const frame = this.exitFrame();
    for (const ws of this.sockets) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(frame);
        } catch {
          // ignore
        }
      }
    }
    // Ring buffer is intentionally kept for late viewers.
    this.logger.info(`exited with code ${exitCode}`);
  }

  private exitFrame(): Buffer {
    const payload: TermExitPayload = { exitCode: this.exitCode };
    return Buffer.concat([
      Buffer.from([TERM_OP.EXIT]),
      Buffer.from(JSON.stringify(payload), 'utf8'),
    ]);
  }

  private checkBackpressure(): void {
    if (this.paused || this.exited) return;
    for (const ws of this.sockets) {
      if (ws.bufferedAmount > HIGH_WATER) {
        this.paused = true;
        try {
          this.pty.pause();
        } catch {
          // ignore
        }
        this.flowTimer = setInterval(() => this.maybeResume(), FLOW_CHECK_MS);
        return;
      }
    }
  }

  private maybeResume(): void {
    for (const ws of this.sockets) {
      if (ws.readyState === ws.OPEN && ws.bufferedAmount > LOW_WATER) return;
    }
    if (this.flowTimer) {
      clearInterval(this.flowTimer);
      this.flowTimer = null;
    }
    if (!this.paused) return;
    this.paused = false;
    if (!this.exited) {
      try {
        this.pty.resume();
      } catch {
        // ignore
      }
    }
  }

  private clearTimers(): void {
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    if (this.flowTimer) {
      clearInterval(this.flowTimer);
      this.flowTimer = null;
    }
  }
}

function resolveCommand(command: string | undefined): { file: string; args: string[] } {
  const win = process.platform === 'win32';
  const shell = win ? 'powershell.exe' : process.platform === 'darwin' ? 'zsh' : 'bash';
  if (command && command.trim()) {
    // Run through the shell so PATH/shims resolve (never spawn .cmd shims directly
    // on Windows — spawn EINVAL since the CVE-2024-27980 fix).
    return win
      ? { file: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-Command', command] }
      : { file: shell, args: ['-ilc', command] };
  }
  return win ? { file: shell, args: ['-NoLogo'] } : { file: shell, args: [] };
}
