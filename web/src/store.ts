import { create } from 'zustand';
import type { ChatEventEnvelope, ServerConfig, SessionMeta } from '@remotty/shared';
import {
  foldEvents,
  initialChatState,
  type ChatUiState,
} from './lib/chat-reducer';

export type ConnState = 'connecting' | 'open' | 'closed';

function sortSessions(list: SessionMeta[]): SessionMeta[] {
  return [...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

interface Store {
  /** null = sconosciuto (probe in corso), false = serve login. */
  authed: boolean | null;
  config: ServerConfig | null;
  sessions: SessionMeta[];
  sessionsLoaded: boolean;
  /** Stato conversazione derivato (fold replay-safe), per sessione chat. */
  chats: Record<string, ChatUiState>;

  setAuthed(v: boolean | null): void;
  setConfig(c: ServerConfig): void;
  setSessions(s: SessionMeta[]): void;
  upsertSession(meta: SessionMeta): void;
  removeSession(id: string): void;
  chatFold(id: string, envs: readonly ChatEventEnvelope[]): void;
  chatAttached(id: string, meta: SessionMeta): void;
  chatReset(id: string): void;
}

export const useStore = create<Store>((set) => ({
  authed: null,
  config: null,
  sessions: [],
  sessionsLoaded: false,
  chats: {},

  setAuthed: (authed) => set({ authed }),
  setConfig: (config) => set({ config }),
  setSessions: (sessions) => set({ sessions: sortSessions(sessions), sessionsLoaded: true }),
  upsertSession: (meta) =>
    set((s) => ({
      sessions: sortSessions([meta, ...s.sessions.filter((x) => x.id !== meta.id)]),
    })),
  removeSession: (id) =>
    set((s) => {
      const chats = { ...s.chats };
      delete chats[id];
      return { sessions: s.sessions.filter((x) => x.id !== id), chats };
    }),

  chatFold: (id, envs) =>
    set((s) => ({
      chats: { ...s.chats, [id]: foldEvents(s.chats[id] ?? initialChatState(), envs) },
    })),
  chatAttached: (id, meta) =>
    set((s) => {
      const cur = s.chats[id] ?? initialChatState();
      return {
        chats: {
          ...s.chats,
          [id]: {
            ...cur,
            meta,
            status: meta.status,
          },
        },
        sessions: sortSessions([meta, ...s.sessions.filter((x) => x.id !== meta.id)]),
      };
    }),
  chatReset: (id) =>
    set((s) => ({ chats: { ...s.chats, [id]: initialChatState() } })),
}));
