import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { CreateSessionRequest, SessionMeta } from '@remotty/shared';
import type { ChatHandle } from './chat/base-session.js';
import { OpenCodeChatSession } from './chat/opencode-session.js';
import { EventLog } from './chat/event-log.js';
import { TerminalSession } from './terminal/terminal-session.js';
import type { AppConfig } from './config.js';
import type { OpenCodeServer } from './opencode/server.js';
import type { Store } from './store.js';
import { createLogger } from './logger.js';

/**
 * Owns the id → live-handle maps. Terminal sessions spawn at create time;
 * chat sessions are created lazily on first attach (and only start the agent
 * on the first user_message).
 */
export class SessionManager {
  private readonly chats = new Map<string, ChatHandle>();
  private readonly terminals = new Map<string, TerminalSession>();
  private readonly logs = new Map<string, EventLog>();
  private readonly logger = createLogger('sessions');

  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
    private readonly ocServer: OpenCodeServer,
  ) {}

  createSession(req: CreateSessionRequest): SessionMeta {
    const now = new Date().toISOString();
    const title = (req.title && req.title.trim()) || path.basename(req.cwd) || req.cwd;
    const meta: SessionMeta = {
      id: randomUUID(),
      kind: req.kind,
      title,
      cwd: req.cwd,
      createdAt: now,
      updatedAt: now,
      status: 'created',
    };
    if (req.kind === 'chat') {
      meta.agent = req.agent;
      meta.opencodeSessionId = null;
      meta.opencodeVariant = null;
      meta.opencodeAgent = null;
    } else if (req.command) {
      meta.command = req.command;
    }
    this.store.upsertSession(meta);
    this.store.touchProject(req.cwd);

    if (req.kind === 'terminal') {
      try {
        this.terminals.set(
          meta.id,
          new TerminalSession(meta, (m) => this.persistMeta(m), createLogger(scope('term', meta.id))),
        );
      } catch (err) {
        this.logger.error(`terminal spawn failed for ${meta.id}:`, err);
        meta.status = 'error';
        this.persistMeta(meta);
      }
    }
    return meta;
  }

  /** Shared per-session JSONL log — same instance for REST replay and the live ChatSession. */
  getEventLog(id: string): EventLog {
    let log = this.logs.get(id);
    if (!log) {
      log = new EventLog(
        path.join(this.config.chatDir, `${id}.jsonl`),
        createLogger(scope('log', id)),
      );
      this.logs.set(id, log);
    }
    return log;
  }

  getOrCreateChat(meta: SessionMeta): ChatHandle {
    let session = this.chats.get(meta.id);
    if (!session) {
      session = new OpenCodeChatSession({
        meta,
        log: this.getEventLog(meta.id),
        config: this.config,
        onMetaChanged: (m: SessionMeta) => this.persistMeta(m),
        logger: createLogger(scope('oc', meta.id)),
        ocServer: this.ocServer,
      });
      this.chats.set(meta.id, session);
    }
    return session;
  }

  getTerminal(id: string): TerminalSession | undefined {
    return this.terminals.get(id);
  }

  async deleteSession(id: string): Promise<void> {
    const chat = this.chats.get(id);
    if (chat) {
      try {
        chat.dispose();
      } catch (err) {
        this.logger.warn(`chat dispose failed for ${id}:`, err);
      }
      this.chats.delete(id);
    }
    const term = this.terminals.get(id);
    if (term) {
      try {
        term.kill();
      } catch (err) {
        this.logger.warn(`terminal kill failed for ${id}:`, err);
      }
      this.terminals.delete(id);
    }
    const meta = this.store.getSession(id);
    if (meta?.kind === 'chat' || this.logs.has(id)) {
      try {
        await this.getEventLog(id).delete();
      } catch (err) {
        this.logger.warn(`chat log delete failed for ${id}:`, err);
      }
      this.logs.delete(id);
    }
    this.store.deleteSession(id);
  }

  private persistMeta(meta: SessionMeta): void {
    // A live handle can outlive deletion (e.g. the pty exit event fires after
    // DELETE already removed the meta) — never resurrect a deleted session.
    if (!this.store.getSession(meta.id)) return;
    meta.updatedAt = new Date().toISOString();
    this.store.upsertSession(meta);
  }
}

function scope(kind: string, id: string): string {
  return `${kind}:${id.slice(0, 8)}`;
}
