// Wrapper fetch tipato per l'API REST. Su 401 marca lo store come non
// autenticato: il router reindirizza a /login.

import type {
  BrowseResult,
  ChatEventsPage,
  CreateSessionRequest,
  OpencodeAgentsResponse,
  OpencodeModelsResponse,
  ProjectInfo,
  ServerConfig,
  SessionMeta,
} from '@remotty/shared';
import { useStore } from '../store';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) {
    useStore.getState().setAuthed(false);
    throw new ApiError(401, 'Non autenticato');
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (body && typeof body.error === 'string') msg = body.error;
    } catch {
      /* corpo non JSON */
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  login: (token: string) =>
    req<void>('/api/auth/login', { method: 'POST', body: JSON.stringify({ token }) }),
  me: () => req<{ ok: boolean }>('/api/auth/me'),
  config: () => req<ServerConfig>('/api/config'),
  browse: (path?: string) =>
    req<BrowseResult>(`/api/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  projects: () => req<ProjectInfo[]>('/api/projects'),
  addProject: (path: string) =>
    req<ProjectInfo>('/api/projects', { method: 'POST', body: JSON.stringify({ path }) }),
  sessions: () => req<SessionMeta[]>('/api/sessions'),
  createSession: (body: CreateSessionRequest) =>
    req<SessionMeta>('/api/sessions', { method: 'POST', body: JSON.stringify(body) }),
  session: (id: string) => req<SessionMeta>(`/api/sessions/${encodeURIComponent(id)}`),
  deleteSession: (id: string) =>
    req<void>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  events: (id: string, afterSeq: number) =>
    req<ChatEventsPage>(`/api/sessions/${encodeURIComponent(id)}/events?afterSeq=${afterSeq}`),
  opencodeModels: (cwd?: string) =>
    req<OpencodeModelsResponse>(
      `/api/opencode/models${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`,
    ),
  opencodeAgents: (cwd?: string) =>
    req<OpencodeAgentsResponse>(
      `/api/opencode/agents${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`,
    ),
};
