import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SessionMeta } from '@remotty/shared';
import { api } from '../lib/api';
import { useStore } from '../store';
import { basename, fmtCost, relTime } from '../lib/format';
import StatusBadge from '../components/StatusBadge';
import NewSessionSheet from '../components/NewSessionSheet';
import { IconChat, IconKebab, IconPlus, IconTerminal, IconTrash } from '../components/icons';

export default function Home() {
  const navigate = useNavigate();
  const sessions = useStore((s) => s.sessions);
  const sessionsLoaded = useStore((s) => s.sessionsLoaded);
  const config = useStore((s) => s.config);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [reachable, setReachable] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      useStore.getState().setSessions(await api.sessions());
      setReachable(true);
    } catch {
      setReachable(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onVis = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVis);
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 15_000);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(t);
    };
  }, [refresh]);

  const remove = async (id: string): Promise<void> => {
    setMenuFor(null);
    if (!window.confirm('Delete this session?')) return;
    try {
      await api.deleteSession(id);
      useStore.getState().removeSession(id);
    } catch {
      void refresh();
    }
  };

  return (
    <div className="flex h-full flex-col pt-safe">
      {/* Header */}
      <header className="flex items-center justify-between px-5 pt-3 pb-2">
        <div className="flex items-center gap-2.5">
          <img src="/icon.svg" alt="" className="h-8 w-8 rounded-lg" />
          <h1 className="text-lg font-semibold text-zinc-100">remotty</h1>
        </div>
        <span
          className="flex items-center gap-1.5 text-[11px] text-zinc-500"
          title={config ? config.platform : ''}
        >
          <span
            className={`h-2 w-2 rounded-full ${reachable ? 'bg-emerald-400' : 'bg-red-500'}`}
          />
          {reachable ? 'connected' : 'offline'}
        </span>
      </header>

      {/* Lista sessioni */}
      <main className="min-h-0 flex-1 overflow-y-auto px-4 pb-28">
        {sessionsLoaded && sessions.length === 0 && (
          <div className="mt-24 text-center text-sm text-zinc-500">
            No sessions yet.
            <br />
            Create one with the + button
          </div>
        )}
        <div className="space-y-2.5 pt-2">
          {sessions.map((s) => (
            <SessionCard
              key={s.id}
              meta={s}
              menuOpen={menuFor === s.id}
              onOpen={() => navigate(s.kind === 'chat' ? `/chat/${s.id}` : `/term/${s.id}`)}
              onMenu={() => setMenuFor(menuFor === s.id ? null : s.id)}
              onDelete={() => void remove(s.id)}
            />
          ))}
        </div>
      </main>

      {/* Backdrop per chiudere il menu kebab */}
      {menuFor !== null && (
        <div className="fixed inset-0 z-10" onClick={() => setMenuFor(null)} />
      )}

      {/* FAB */}
      <button
        onClick={() => setSheetOpen(true)}
        className="fixed right-5 z-20 grid h-14 w-14 place-items-center rounded-2xl bg-accent text-black shadow-lg shadow-emerald-500/20 active:opacity-80"
        style={{ bottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)' }}
        aria-label="New session"
      >
        <IconPlus className="h-6 w-6" />
      </button>

      <NewSessionSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </div>
  );
}

function SessionCard({
  meta,
  menuOpen,
  onOpen,
  onMenu,
  onDelete,
}: {
  meta: SessionMeta;
  menuOpen: boolean;
  onOpen: () => void;
  onMenu: () => void;
  onDelete: () => void;
}) {
  const Icon = meta.kind === 'chat' ? IconChat : IconTerminal;
  return (
    <div className="relative rounded-2xl border border-white/5 bg-surface">
      <button onClick={onOpen} className="flex w-full items-start gap-3 p-4 pr-12 text-left">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-raised text-accent">
          <Icon className="h-4.5 w-4.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-zinc-100">
            {meta.title || basename(meta.cwd)}
          </span>
          <span className="mt-0.5 block truncate text-xs text-zinc-500">
            {basename(meta.cwd)} · {relTime(meta.updatedAt)}
          </span>
          <span className="mt-2 flex items-center gap-2">
            <StatusBadge status={meta.status} />
            {meta.kind === 'chat' && typeof meta.totalCostUsd === 'number' && (
              <span className="text-[11px] text-zinc-500">{fmtCost(meta.totalCostUsd)}</span>
            )}
            {meta.kind === 'terminal' && meta.exitCode != null && (
              <span className="text-[11px] text-zinc-500">exit {meta.exitCode}</span>
            )}
          </span>
        </span>
      </button>

      <button
        onClick={onMenu}
        className="absolute top-2.5 right-1.5 grid h-11 w-11 place-items-center rounded-full text-zinc-500 active:bg-white/5"
        aria-label="Session menu"
      >
        <IconKebab className="h-4.5 w-4.5" />
      </button>

      {menuOpen && (
        <div className="absolute top-12 right-3 z-20 overflow-hidden rounded-xl border border-white/10 bg-raised shadow-xl">
          <button
            onClick={onDelete}
            className="flex min-h-11 w-44 items-center gap-2.5 px-4 text-sm text-red-400 active:bg-white/5"
          >
            <IconTrash className="h-4 w-4" />
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
