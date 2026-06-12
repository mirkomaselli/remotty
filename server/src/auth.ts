import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from 'express';

const COOKIE_NAME = 'remotty_auth';
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

export interface Auth {
  /** POST /api/auth/login */
  loginHandler: RequestHandler;
  /** Guards every /api/* route mounted after it (health + login are mounted before). */
  middleware: RequestHandler;
  /** For WS upgrades — cookie or Authorization: Bearer. Never reads the query string. */
  authorizeUpgrade(req: IncomingMessage): boolean;
}

export function createAuth(token: string | null): Auth {
  const required = typeof token === 'string' && token.length > 0;

  const isAuthorized = (cookieVal: string | undefined, authHeader: string | undefined): boolean => {
    if (!required) return true;
    if (cookieVal !== undefined && safeEqual(cookieVal, token as string)) return true;
    if (authHeader?.startsWith('Bearer ') && safeEqual(authHeader.slice(7), token as string)) {
      return true;
    }
    return false;
  };

  const loginHandler: RequestHandler = (req, res) => {
    if (!required) {
      res.status(204).end();
      return;
    }
    const supplied = (req.body as { token?: unknown } | undefined)?.token;
    if (typeof supplied !== 'string' || !safeEqual(supplied, token as string)) {
      res.status(401).json({ error: 'invalid token' });
      return;
    }
    res.cookie(COOKIE_NAME, supplied, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure, // plain LAN HTTP must still work
      maxAge: COOKIE_MAX_AGE_MS,
      path: '/',
    });
    res.status(204).end();
  };

  const middleware: RequestHandler = (req, res, next) => {
    const cookies = (req as { cookies?: Record<string, string | undefined> }).cookies;
    if (isAuthorized(cookies?.[COOKIE_NAME], req.headers.authorization)) {
      next();
      return;
    }
    res.status(401).json({ error: 'unauthorized' });
  };

  const authorizeUpgrade = (req: IncomingMessage): boolean => {
    if (!required) return true;
    const cookieVal = parseCookieHeader(req.headers.cookie)[COOKIE_NAME];
    return isAuthorized(cookieVal, req.headers.authorization);
  };

  return { loginHandler, middleware, authorizeUpgrade };
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch; the length check leaks only the length.
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Minimal cookie parser for raw upgrade requests (cookie-parser only runs in Express). */
function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep raw value
    }
    if (name) out[name] = value;
  }
  return out;
}
