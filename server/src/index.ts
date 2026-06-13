import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { loadConfig } from './config.js';
import { createAuth } from './auth.js';
import { Store } from './store.js';
import { SessionManager } from './session-manager.js';
import { OpenCodeServer } from './opencode/server.js';
import { createApiRouter } from './api.js';
import { setupWebSocket } from './ws.js';
import { createLogger } from './logger.js';
import { PushService } from './push-service.js';

const logger = createLogger('server');

const config = loadConfig();
const store = new Store(config.dataDir);
const ocServer = new OpenCodeServer(config.opencodePort, createLogger('opencode'));
const push = new PushService(config.dataDir, createLogger('push'));
const manager = new SessionManager(store, config, ocServer, push);
const auth = createAuth(config.authToken);

const app = express();
app.disable('x-powered-by');
// Trust X-Forwarded-* only from loopback proxies (e.g. Tailscale Serve, which
// terminates TLS and forwards to 127.0.0.1): req.secure is then true behind
// HTTPS, so the auth cookie gets the Secure flag. Direct LAN HTTP is unaffected.
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
const apiRouter = createApiRouter({ config, store, manager, auth, ocServer, push });
app.use('/api', apiRouter);
if (config.basePath) app.use(`${config.basePath}/api`, apiRouter);

// --- static web app (production) ---------------------------------------------
// Both src/index.ts (tsx) and dist/index.js resolve ../../web/dist to <repo>/web/dist.
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
const indexHtml = path.join(webDist, 'index.html');
if (existsSync(indexHtml)) {
  const serveWeb = express.static(webDist);
  if (config.basePath) {
    app.get('/', (_req, res) => res.redirect(`${config.basePath}/`));
    app.use(config.basePath, serveWeb);
  } else {
    app.use(serveWeb);
  }
  // SPA fallback for client-side routes.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const inWebApp =
      !config.basePath ||
      req.path === config.basePath ||
      req.path.startsWith(`${config.basePath}/`);
    if (req.method !== 'GET' || !inWebApp || req.path.includes('/api/')) {
      next();
      return;
    }
    res.sendFile(indexHtml);
  });
} else {
  logger.warn(
    `web/dist not found at ${webDist} — UI not served. Run "npm run build -w @remotty/web" (API + WS still available).`,
  );
}

// Final JSON error handler.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('unhandled request error:', err);
  if (!res.headersSent) res.status(500).json({ error: 'internal error' });
});

const server = http.createServer(app);
setupWebSocket(server, { auth, manager, store, basePath: config.basePath });

server.listen(config.port, config.host, () => {
  logger.info(`remotty v${config.version} (${config.platform}) — data dir: ${config.dataDir}`);
  logger.info(`detected CLIs: opencode=${config.clis.opencode}`);
  if (config.basePath) logger.info(`web base path: ${config.basePath}`);
  for (const url of reachableUrls(config.host, config.port)) {
    logger.info(`  → ${url}`);
  }
  if (!config.authToken) {
    logger.warn('');
    logger.warn('  !!! WARNING: REMOTTY_AUTH_TOKEN is not set — AUTHENTICATION IS DISABLED. !!!');
    logger.warn('  !!! Anyone who can reach this port can run commands on this machine. !!!');
    logger.warn('');
  }
});

function reachableUrls(host: string, port: number): string[] {
  if (host !== '0.0.0.0' && host !== '::' && host !== '') {
    return [`http://${host}:${port}`];
  }
  const urls = [`http://localhost:${port}`];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (!a.internal && a.family === 'IPv4') urls.push(`http://${a.address}:${port}`);
    }
  }
  return urls;
}

// A single failing session must never take the whole server down.
process.on('uncaughtException', (err) => logger.error('uncaughtException:', err));
process.on('unhandledRejection', (reason) => logger.error('unhandledRejection:', reason));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    logger.info(`${sig} received — flushing state and shutting down`);
    ocServer.stopSync();
    push.flushSync();
    store.flushSync();
    process.exit(0);
  });
}
