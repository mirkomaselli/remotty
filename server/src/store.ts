import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import type { ProjectInfo, SessionMeta } from '@remotty/shared';
import { createLogger } from './logger.js';

const SAVE_DEBOUNCE_MS = 250;
const MAX_RECENT_PROJECTS = 50;

type StoreFile = 'sessions' | 'projects';

/** JSON persistence: data/sessions.json + data/projects.json. Debounced atomic writes. */
export class Store {
  private readonly sessions = new Map<string, SessionMeta>();
  private projects: ProjectInfo[] = [];
  private readonly sessionsFile: string;
  private readonly projectsFile: string;
  private readonly timers = new Map<StoreFile, NodeJS.Timeout>();
  private readonly chains = new Map<StoreFile, Promise<void>>();
  private readonly logger = createLogger('store');

  constructor(dataDir: string) {
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this.projectsFile = path.join(dataDir, 'projects.json');
    this.load();
  }

  private load(): void {
    for (const meta of readJsonArray<SessionMeta>(this.sessionsFile)) {
      if (!meta || typeof meta.id !== 'string') continue;
      // No child process survives a server restart.
      if (meta.kind === 'terminal') {
        if (meta.status !== 'exited' && meta.status !== 'error') meta.status = 'exited';
      } else {
        // Chat sessions are resumable via the agent session id; without one nothing ever started.
        meta.status = meta.opencodeSessionId ? 'idle' : 'created';
      }
      this.sessions.set(meta.id, meta);
    }
    this.projects = readJsonArray<ProjectInfo>(this.projectsFile).filter(
      (p) => p && typeof p.path === 'string',
    );
  }

  getSessions(): SessionMeta[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getSession(id: string): SessionMeta | undefined {
    return this.sessions.get(id);
  }

  upsertSession(meta: SessionMeta): void {
    this.sessions.set(meta.id, meta);
    this.scheduleSave('sessions');
  }

  deleteSession(id: string): void {
    if (this.sessions.delete(id)) this.scheduleSave('sessions');
  }

  getProjects(): ProjectInfo[] {
    return [...this.projects];
  }

  touchProject(p: string): ProjectInfo {
    const resolved = path.resolve(p);
    const norm = (x: string): string => (process.platform === 'win32' ? x.toLowerCase() : x);
    const info: ProjectInfo = {
      path: resolved,
      name: path.basename(resolved) || resolved,
      isGitRepo: existsSync(path.join(resolved, '.git')),
      lastUsedAt: new Date().toISOString(),
    };
    this.projects = [
      info,
      ...this.projects.filter((x) => norm(x.path) !== norm(resolved)),
    ].slice(0, MAX_RECENT_PROJECTS);
    this.scheduleSave('projects');
    return info;
  }

  private scheduleSave(which: StoreFile): void {
    const prev = this.timers.get(which);
    if (prev) clearTimeout(prev);
    this.timers.set(
      which,
      setTimeout(() => {
        this.timers.delete(which);
        this.write(which);
      }, SAVE_DEBOUNCE_MS),
    );
  }

  private serialize(which: StoreFile): { file: string; json: string } {
    const file = which === 'sessions' ? this.sessionsFile : this.projectsFile;
    const data = which === 'sessions' ? this.getSessions() : this.projects;
    return { file, json: JSON.stringify(data, null, 2) };
  }

  private write(which: StoreFile): void {
    const { file, json } = this.serialize(which);
    const chain = (this.chains.get(which) ?? Promise.resolve())
      .then(async () => {
        const tmp = `${file}.tmp`;
        await fsp.writeFile(tmp, json, 'utf8');
        await fsp.rename(tmp, file); // atomic on the same volume (replaces on Windows too)
      })
      .catch((err) => this.logger.error(`write ${file} failed:`, err));
    this.chains.set(which, chain);
  }

  /** Synchronous flush for shutdown handlers. */
  flushSync(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const which of ['sessions', 'projects'] as const) {
      const { file, json } = this.serialize(which);
      try {
        // Distinct tmp suffix: must not collide with an in-flight async write.
        const tmp = `${file}.tmp-sync`;
        writeFileSync(tmp, json, 'utf8');
        renameSync(tmp, file);
      } catch (err) {
        this.logger.error(`flush ${file} failed:`, err);
      }
    }
  }
}

function readJsonArray<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
