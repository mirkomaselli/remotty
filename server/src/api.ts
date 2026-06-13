import { Router } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import path from 'node:path';
import type {
  ChatEventsPage,
  CreateSessionRequest,
  HealthResponse,
  OpencodeAgentsResponse,
  OpencodePermissionLevel,
  OpencodeModelsResponse,
  PairingConfig,
  PushConfigResponse,
  PushDiagnosticInput,
  PushSubscriptionInput,
} from '@remotty/shared';
import { isDirectory, toServerConfig } from './config.js';
import type { AppConfig } from './config.js';
import type { Auth } from './auth.js';
import type { Store } from './store.js';
import type { SessionManager } from './session-manager.js';
import type { OpenCodeServer } from './opencode/server.js';
import { createBrowseHandler } from './fs-browse.js';
import { createLogger } from './logger.js';
import type { PushService } from './push-service.js';

export function createApiRouter(deps: {
  config: AppConfig;
  store: Store;
  manager: SessionManager;
  auth: Auth;
  ocServer: OpenCodeServer;
  push: PushService;
}): Router {
  const { config, store, manager, auth, ocServer, push } = deps;
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
  router.get('/pairing', (req, res) => {
    const body: PairingConfig = {
      version: 1,
      serverUrl: `${req.protocol}://${req.get('host') ?? ''}${config.basePath}`,
      token: config.authToken ?? '',
    };
    res.set('Cache-Control', 'no-store').json(body);
  });
  router.get('/push/config', (_req, res) => {
    const body: PushConfigResponse = { supported: true, publicKey: push.publicKey() };
    res.json(body);
  });
  router.post('/push/subscriptions', (req, res) => {
    try {
      push.subscribe(req.body as PushSubscriptionInput);
      res.status(204).end();
    } catch {
      res.status(400).json({ error: 'invalid push subscription' });
    }
  });
  router.delete('/push/subscriptions', (req, res) => {
    const endpoint = (req.body as { endpoint?: unknown } | undefined)?.endpoint;
    if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) {
      res.status(400).json({ error: 'invalid push endpoint' });
      return;
    }
    push.unsubscribe(endpoint);
    res.status(204).end();
  });
  router.post('/push/diagnostics', (req, res) => {
    const body = req.body as Partial<PushDiagnosticInput> | undefined;
    if (!body || typeof body.stage !== 'string') {
      res.status(400).json({ error: 'invalid push diagnostic' });
      return;
    }
    logger.info(
      `push diagnostic stage=${cleanLog(body.stage)} secure=${body.secureContext === true} ` +
        `standalone=${body.standalone === true} permission=${cleanLog(body.permission)} ` +
        `error=${cleanLog(body.errorName)}:${cleanLog(body.errorMessage)}`,
    );
    res.status(204).end();
  });
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
          models?: Record<
            string,
            {
              id?: string;
              name?: string;
              variants?: Record<string, { disabled?: boolean }>;
              capabilities?: {
                input?: Partial<Record<'text' | 'audio' | 'image' | 'video' | 'pdf', boolean>>;
              };
            }
          >;
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
                  variants: Object.entries(m.variants ?? {})
                    .filter(([, options]) => options?.disabled !== true)
                    .map(([variant]) => variant)
                    .sort(compareVariants),
                  input: {
                    text: m.capabilities?.input?.text === true,
                    audio: m.capabilities?.input?.audio === true,
                    image: m.capabilities?.input?.image === true,
                    video: m.capabilities?.input?.video === true,
                    pdf: m.capabilities?.input?.pdf === true,
                  },
                }))
                .sort((a, b) => a.name.localeCompare(b.name)),
            };
          }),
      };
      res.json(body);
    }),
  );

  // Agenti utilizzabili come principale: built-in build/plan e custom primary/all.
  router.get(
    '/opencode/agents',
    ah(async (req, res) => {
      if (!config.clis.opencode) {
        res.status(400).json({ error: 'opencode CLI non disponibile' });
        return;
      }
      await ocServer.ensureStarted();
      const cwd = typeof req.query.cwd === 'string' && req.query.cwd ? req.query.cwd : null;
      const url = `${ocServer.baseUrl}/agent${cwd ? `?directory=${encodeURIComponent(cwd)}` : ''}`;
      const r = await fetch(url);
      if (!r.ok) {
        res.status(502).json({ error: `opencode HTTP ${r.status}` });
        return;
      }
      const data = (await r.json()) as Array<{
        name?: string;
        description?: string;
        mode?: string;
        native?: boolean;
        hidden?: boolean;
        permission?: Array<{
          permission?: string;
          pattern?: string;
          action?: 'allow' | 'ask' | 'deny';
        }>;
      }>;
      const body: OpencodeAgentsResponse = {
        agents: (Array.isArray(data) ? data : [])
          .filter(
            (agent) =>
              typeof agent.name === 'string' &&
              agent.name.length > 0 &&
              agent.hidden !== true &&
              (agent.mode === 'primary' || agent.mode === 'all'),
          )
          .map((agent) => ({
            name: agent.name as string,
            ...(typeof agent.description === 'string' && agent.description
              ? { description: agent.description }
              : {}),
            mode: agent.mode as 'primary' | 'all',
            native: agent.native === true,
            permissions: {
              edit: summarizePermission(agent.permission, 'edit'),
              bash: summarizePermission(agent.permission, 'bash'),
            },
          }))
          .sort(compareAgents),
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

const VARIANT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function compareVariants(a: string, b: string): number {
  const ai = VARIANT_ORDER.indexOf(a);
  const bi = VARIANT_ORDER.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}

function summarizePermission(
  rules: Array<{ permission?: string; pattern?: string; action?: 'allow' | 'ask' | 'deny' }> | undefined,
  permission: string,
): OpencodePermissionLevel {
  let broad: 'allow' | 'ask' | 'deny' | undefined;
  let hasSpecific = false;
  for (const rule of rules ?? []) {
    if (rule.permission !== '*' && rule.permission !== permission) continue;
    if (!rule.action) continue;
    if (rule.pattern === '*' || rule.pattern === undefined) broad = rule.action;
    else if (rule.permission === permission) hasSpecific = true;
  }
  if (hasSpecific) return 'mixed';
  return broad ?? 'unknown';
}

function compareAgents(a: { name: string }, b: { name: string }): number {
  const order = ['build', 'plan'];
  const ai = order.indexOf(a.name);
  const bi = order.indexOf(b.name);
  if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}

function cleanLog(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\r\n]/g, ' ').slice(0, 200) : '-';
}

/** Wraps an async handler so rejections reach the error middleware. */
function ah(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}
