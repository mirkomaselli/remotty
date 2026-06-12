import { Router } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import path from 'node:path';
import type {
  ChatEventsPage,
  CreateSessionRequest,
  HealthResponse,
  OpencodeModelsResponse,
} from '@remotty/shared';
import { isDirectory, toServerConfig } from './config.js';
import type { AppConfig } from './config.js';
import type { Auth } from './auth.js';
import type { Store } from './store.js';
import type { SessionManager } from './session-manager.js';
import type { OpenCodeServer } from './opencode/server.js';
import { createBrowseHandler } from './fs-browse.js';
import { createLogger } from './logger.js';

export function createApiRouter(deps: {
  config: AppConfig;
  store: Store;
  manager: SessionManager;
  auth: Auth;
  ocServer: OpenCodeServer;
}): Router {
  const { config, store, manager, auth, ocServer } = deps;
  const logger = createLogger('api');
  const router = Router();

  // --- unauthenticated -------------------------------------------------------
  router.get('/health', (_req, res) => {
    const body: HealthResponse = { ok: true, version: config.version };
    res.json(body);
  });
  router.post('/auth/login', auth.loginHandler);

  // --- everything below requires auth ---------------------------------------
  router.use(auth.middleware);

  router.get('/auth/me', (_req, res) => res.json({ ok: true }));
  router.get('/config', (_req, res) => res.json(toServerConfig(config)));
  router.get('/fs/browse', createBrowseHandler(config));

  router.get('/projects', (_req, res) => res.json(store.getProjects()));

  router.post('/projects', (req, res) => {
    const p = (req.body as { path?: unknown } | undefined)?.path;
    if (typeof p !== 'string' || !path.isAbsolute(p)) {
      res.status(400).json({ error: 'path must be an absolute path' });
      return;
    }
    const resolved = path.resolve(p);
    if (!isDirectory(resolved)) {
      res.status(400).json({ error: 'directory does not exist' });
      return;
    }
    res.json(store.touchProject(resolved));
  });

  // Lista provider/modelli OpenCode per il picker (avvia opencode serve se serve).
  router.get(
    '/opencode/models',
    ah(async (req, res) => {
      if (!config.clis.opencode) {
        res.status(400).json({ error: 'opencode CLI non disponibile' });
        return;
      }
      await ocServer.ensureStarted();
      const cwd = typeof req.query.cwd === 'string' && req.query.cwd ? req.query.cwd : null;
      const url = `${ocServer.baseUrl}/config/providers${
        cwd ? `?directory=${encodeURIComponent(cwd)}` : ''
      }`;
      const r = await fetch(url);
      if (!r.ok) {
        res.status(502).json({ error: `opencode HTTP ${r.status}` });
        return;
      }
      const data = (await r.json()) as {
        providers?: Array<{
          id?: string;
          name?: string;
          models?: Record<string, { id?: string; name?: string }>;
        }>;
        default?: Record<string, string>;
      };
      const body: OpencodeModelsResponse = {
        providers: (data.providers ?? [])
          .filter((p) => typeof p.id === 'string' && p.id)
          .map((p) => {
            const id = p.id as string;
            const defaultModelID = data.default?.[id];
            return {
              id,
              name: typeof p.name === 'string' && p.name ? p.name : id,
              ...(defaultModelID ? { defaultModelID } : {}),
              models: Object.entries(p.models ?? {})
                .map(([modelId, m]) => ({
                  id: m.id ?? modelId,
                  name: typeof m.name === 'string' && m.name ? m.name : modelId,
                }))
                .sort((a, b) => a.name.localeCompare(b.name)),
            };
          }),
      };
      res.json(body);
    }),
  );

  router.get('/sessions', (_req, res) => res.json(store.getSessions()));

  router.post('/sessions', (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const kind = body?.kind;
    const cwd = body?.cwd;
    if (kind !== 'chat' && kind !== 'terminal') {
      res.status(400).json({ error: "kind must be 'chat' or 'terminal'" });
      return;
    }
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      res.status(400).json({ error: 'cwd must be an absolute path' });
      return;
    }
    const resolvedCwd = path.resolve(cwd);
    if (!isDirectory(resolvedCwd)) {
      res.status(400).json({ error: 'cwd does not exist or is not a directory' });
      return;
    }
    const title = typeof body?.title === 'string' && body.title.trim() ? body.title.trim() : undefined;

    let request: CreateSessionRequest;
    if (kind === 'chat') {
      const agent = body?.agent;
      if (agent !== 'opencode') {
        res.status(400).json({ error: "agent must be 'opencode'" });
        return;
      }
      request = {
        kind: 'chat',
        cwd: resolvedCwd,
        agent,
        ...(title ? { title } : {}),
      };
    } else {
      const command =
        typeof body?.command === 'string' && body.command.trim() ? body.command.trim() : undefined;
      request = {
        kind: 'terminal',
        cwd: resolvedCwd,
        ...(title ? { title } : {}),
        ...(command ? { command } : {}),
      };
    }
    const meta = manager.createSession(request);
    res.status(201).json(meta);
  });

  router.get('/sessions/:id', (req, res) => {
    const meta = store.getSession(req.params.id ?? '');
    if (!meta) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    res.json(meta);
  });

  router.delete(
    '/sessions/:id',
    ah(async (req, res) => {
      const id = req.params.id ?? '';
      if (!store.getSession(id)) {
        res.status(404).json({ error: 'session not found' });
        return;
      }
      await manager.deleteSession(id);
      res.status(204).end();
    }),
  );

  router.get(
    '/sessions/:id/events',
    ah(async (req, res) => {
      const meta = store.getSession(req.params.id ?? '');
      if (!meta) {
        res.status(404).json({ error: 'session not found' });
        return;
      }
      if (meta.kind !== 'chat') {
        res.status(400).json({ error: 'not a chat session' });
        return;
      }
      const raw = req.query.afterSeq;
      const parsed = typeof raw === 'string' ? Number(raw) : 0;
      const afterSeq = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
      const log = manager.getEventLog(meta.id);
      const events = await log.readAfter(afterSeq);
      const page: ChatEventsPage = { events, lastSeq: log.lastSeq() };
      res.json(page);
    }),
  );

  // JSON error fallthrough (Express 4 does not catch async errors on its own).
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('request failed:', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  });

  return router;
}

/** Wraps an async handler so rejections reach the error middleware. */
function ah(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}
