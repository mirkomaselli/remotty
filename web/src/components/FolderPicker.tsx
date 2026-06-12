import { useEffect, useState } from 'react';
import type { BrowseResult, ProjectInfo } from '@remotty/shared';
import { api } from '../lib/api';
import { basename } from '../lib/format';
import {
  IconChevronLeft,
  IconChevronRight,
  IconFolder,
  IconGit,
  IconHome,
  IconX,
} from './icons';

interface FolderPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
}

interface Crumb {
  label: string;
  path: string;
}

/** Briciole ricostruite preservando i separatori originali (Windows o POSIX). */
function crumbsOf(p: string): Crumb[] {
  const out: Crumb[] = [];
  const re = /[^/\\]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(p)) !== null) {
    const seg = m[0] ?? '';
    let prefix = p.slice(0, m.index + seg.length);
    // 'C:' da solo non è assoluto: serve il separatore dopo la lettera di drive.
    if (/^[A-Za-z]:$/.test(prefix)) prefix += p.includes('\\') ? '\\' : '/';
    out.push({ label: seg, path: prefix });
  }
  if (out.length === 0 && p.length > 0) out.push({ label: p, path: p });
  return out;
}

export default function FolderPicker({ open, onClose, onSelect }: FolderPickerProps) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [cur, setCur] = useState<BrowseResult | null>(null); // null = vista radici
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = async (path?: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setCur(await api.browse(path));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Errore di navigazione');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setCur(null);
    setError(null);
    api.projects().then(setProjects).catch(() => setProjects([]));
    void browse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const atRoots = cur !== null && cur.parent === null && cur.path === '';
  const crumbs = cur && cur.path ? crumbsOf(cur.path) : [];

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-app pt-safe">
      {/* Header */}
      <div className="flex items-center gap-1 border-b border-white/5 px-2 py-2">
        <button
          onClick={() => {
            if (cur?.parent) void browse(cur.parent);
            else if (cur && !atRoots) void browse();
          }}
          disabled={!cur || atRoots}
          className="grid h-11 w-11 place-items-center rounded-full text-zinc-300 active:bg-white/5 disabled:opacity-30"
          aria-label="Cartella superiore"
        >
          <IconChevronLeft />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-zinc-100">
          Scegli cartella
        </h2>
        <button
          onClick={() => void browse()}
          className="grid h-11 w-11 place-items-center rounded-full text-zinc-300 active:bg-white/5"
          aria-label="Radici"
        >
          <IconHome />
        </button>
        <button
          onClick={onClose}
          className="grid h-11 w-11 place-items-center rounded-full text-zinc-300 active:bg-white/5"
          aria-label="Chiudi"
        >
          <IconX />
        </button>
      </div>

      {/* Breadcrumb */}
      {crumbs.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-white/5 px-3 py-2 text-xs whitespace-nowrap">
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center gap-1">
              {i > 0 && <span className="text-zinc-600">/</span>}
              <button
                onClick={() => void browse(c.path)}
                className={`rounded px-1 py-1 ${
                  i === crumbs.length - 1
                    ? 'font-semibold text-zinc-100'
                    : 'text-zinc-400 active:bg-white/5'
                }`}
              >
                {c.label}
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Lista */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {atRoots && projects.length > 0 && (
          <div className="border-b border-white/5 pb-2">
            <div className="px-4 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Progetti recenti
            </div>
            {projects.map((p) => (
              <button
                key={p.path}
                onClick={() => onSelect(p.path)}
                className="flex w-full min-h-12 items-center gap-3 px-4 py-2 text-left active:bg-white/5"
              >
                <IconFolder className="h-5 w-5 shrink-0 text-accent" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-zinc-200">{p.name}</span>
                  <span className="block truncate text-xs text-zinc-500">{p.path}</span>
                </span>
                {p.isGitRepo && <GitBadge />}
              </button>
            ))}
            <div className="px-4 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Sfoglia cartelle
            </div>
          </div>
        )}

        {error && <div className="px-4 py-3 text-sm text-red-400">{error}</div>}
        {loading && <div className="px-4 py-3 text-sm text-zinc-500">caricamento…</div>}
        {!loading &&
          cur?.dirs.map((d) => (
            <div key={d.path} className="flex items-center active:bg-white/5">
              <button
                onClick={() => void browse(d.path)}
                className="flex min-h-12 min-w-0 flex-1 items-center gap-3 px-4 py-2 text-left"
              >
                <IconFolder className="h-5 w-5 shrink-0 text-zinc-400" />
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{d.name}</span>
                {d.isGitRepo && <GitBadge />}
                <IconChevronRight className="h-4 w-4 shrink-0 text-zinc-600" />
              </button>
            </div>
          ))}
        {!loading && cur && cur.dirs.length === 0 && !error && (
          <div className="px-4 py-3 text-sm text-zinc-500">Nessuna sottocartella</div>
        )}
      </div>

      {/* Footer: seleziona la cartella corrente */}
      {cur && cur.path && (
        <div
          className="border-t border-white/5 p-3"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
        >
          <button
            onClick={() => onSelect(cur.path)}
            className="w-full rounded-2xl bg-accent py-3.5 text-sm font-semibold text-black active:opacity-80"
          >
            Seleziona «{basename(cur.path)}»
          </button>
        </div>
      )}
    </div>
  );
}

function GitBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
      <IconGit className="h-3 w-3" />
      git
    </span>
  );
}
