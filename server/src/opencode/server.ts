import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import os from 'node:os';
import type { Logger } from '../logger.js';

const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 400;

/**
 * Lazy singleton around one local `opencode serve` HTTP server (127.0.0.1 only)
 * shared by every OpenCode chat session — sessions are scoped to their project
 * folder via the `?directory=` query param.
 *
 * If something is already answering /global/health on the port (e.g. the user
 * runs their own `opencode serve`), it is adopted instead of spawning.
 */
export class OpenCodeServer {
  readonly baseUrl: string;
  private proc: ChildProcess | null = null;
  private starting: Promise<void> | null = null;

  constructor(
    private readonly port: number,
    private readonly logger: Logger,
  ) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    // Sync last-resort cleanup: a cmd.exe-wrapped child would survive a plain kill.
    process.on('exit', () => this.stopSync());
  }

  async ensureStarted(): Promise<void> {
    if (await this.healthy()) return;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async start(): Promise<void> {
    if (await this.healthy()) return;
    this.spawnProc();
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.proc && this.proc.exitCode !== null) {
        throw new Error(`opencode serve exited immediately (exit ${this.proc.exitCode})`);
      }
      if (await this.healthy()) {
        this.logger.info(`opencode serve pronto su ${this.baseUrl}`);
        return;
      }
      await sleep(READY_POLL_MS);
    }
    this.stopSync();
    throw new Error(`opencode serve non risponde su ${this.baseUrl} entro ${READY_TIMEOUT_MS / 1000}s`);
  }

  private spawnProc(): void {
    const args = ['serve', '--port', String(this.port), '--hostname', '127.0.0.1'];
    // Windows: `opencode` on PATH is a .cmd shim — spawning it directly throws
    // EINVAL (CVE-2024-27980 fix). This child is an HTTP server (stdio is just
    // logs), so wrapping in cmd.exe is safe here, unlike stream-json pipes.
    const proc =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/d', '/s', '/c', 'opencode', ...args], {
            cwd: os.homedir(),
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          })
        : spawn('opencode', args, {
            cwd: os.homedir(),
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
    proc.stdout?.on('data', (d: Buffer) => this.logger.info('[serve]', d.toString().trimEnd()));
    proc.stderr?.on('data', (d: Buffer) => this.logger.warn('[serve]', d.toString().trimEnd()));
    proc.on('error', (err) => {
      this.logger.error('spawn opencode failed:', err);
      if (this.proc === proc) this.proc = null;
    });
    proc.on('exit', (code) => {
      this.logger.warn(`opencode serve exited (code ${code})`);
      if (this.proc === proc) this.proc = null; // next ensureStarted() respawns
    });
    this.proc = proc;
  }

  private async healthy(): Promise<boolean> {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 2000);
      const res = await fetch(`${this.baseUrl}/global/health`, { signal: ctl.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Sync kill for signal/exit handlers. taskkill /T also reaps the cmd.exe child. */
  stopSync(): void {
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.exitCode !== null || proc.pid === undefined) return;
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        proc.kill('SIGTERM');
      }
    } catch {
      // already gone
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
