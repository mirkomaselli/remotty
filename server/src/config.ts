import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerConfig } from '@remotty/shared';

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  /** dataDir/chat — per-session JSONL event logs live here. */
  chatDir: string;
  authToken: string | null;
  /** Port for the locally spawned `opencode serve` (REMOTTY_OPENCODE_PORT). */
  opencodePort: number;
  /** Optional 'providerID/modelID' override for OpenCode prompts (REMOTTY_OPENCODE_MODEL). */
  opencodeModel: string | null;
  homeDir: string;
  defaultRoots: string[];
  platform: NodeJS.Platform;
  version: string;
  clis: { opencode: boolean };
}

export function loadConfig(): AppConfig {
  // Both src/ (tsx) and dist/ (compiled) sit one level below server/, two below the repo root.
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const home = os.homedir();
  const dataDir = process.env.REMOTTY_DATA_DIR
    ? path.resolve(process.env.REMOTTY_DATA_DIR)
    : path.join(repoRoot, 'data');
  const chatDir = path.join(dataDir, 'chat');
  mkdirSync(chatDir, { recursive: true });

  const defaultRoots = [home, path.join(home, 'Desktop'), path.join(home, 'Documents')].filter(
    isDirectory,
  );

  return {
    port: parsePort(process.env.PORT) ?? 7710,
    host: process.env.HOST || '0.0.0.0',
    dataDir,
    chatDir,
    authToken: process.env.REMOTTY_AUTH_TOKEN?.trim() || null,
    opencodePort: parsePort(process.env.REMOTTY_OPENCODE_PORT) ?? 7720,
    opencodeModel: process.env.REMOTTY_OPENCODE_MODEL?.trim() || null,
    homeDir: home,
    defaultRoots,
    platform: process.platform,
    version: readVersion(),
    clis: {
      opencode: cliOnPath('opencode'),
    },
  };
}

export function toServerConfig(c: AppConfig): ServerConfig {
  return {
    version: c.version,
    platform: c.platform,
    homeDir: c.homeDir,
    defaultRoots: c.defaultRoots,
    authRequired: c.authToken !== null,
    clis: c.clis,
  };
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function parsePort(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function readVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Cross-platform "is <name> on PATH" — never spawns the tool itself (Windows .cmd shim hazard). */
function cliOnPath(name: string): boolean {
  try {
    const r =
      process.platform === 'win32'
        ? spawnSync('where.exe', [name], { stdio: 'ignore', timeout: 5000 })
        : spawnSync('which', [name], { stdio: 'ignore', timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}
