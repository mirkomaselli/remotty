import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CreateSessionRequest } from '@remotty/shared';
import { api } from '../lib/api';
import { useStore } from '../store';
import { basename } from '../lib/format';
import Sheet from './Sheet';
import FolderPicker from './FolderPicker';
import { IconChat, IconFolder, IconTerminal } from './icons';

interface NewSessionSheetProps {
  open: boolean;
  onClose: () => void;
}

export default function NewSessionSheet({ open, onClose }: NewSessionSheetProps) {
  const navigate = useNavigate();
  const config = useStore((s) => s.config);
  const [kind, setKind] = useState<'chat' | 'terminal'>('chat');
  const [cwd, setCwd] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const opencodeAvailable = config?.clis.opencode ?? false;

  const create = async (): Promise<void> => {
    if (!cwd || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: CreateSessionRequest =
        kind === 'chat' ? { kind: 'chat', cwd, agent: 'opencode' } : { kind: 'terminal', cwd };
      const meta = await api.createSession(body);
      // Upsert nei progetti recenti; non bloccante se fallisce.
      api.addProject(cwd).catch(() => {});
      useStore.getState().upsertSession(meta);
      onClose();
      navigate(meta.kind === 'chat' ? `/chat/${meta.id}` : `/term/${meta.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Creazione fallita');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Sheet open={open} title="Nuova sessione" onClose={onClose}>
        <div className="space-y-5">
          {/* Tipo */}
          <div className="grid grid-cols-2 gap-1 rounded-2xl bg-raised p-1">
            {(
              [
                { k: 'chat', label: 'Chat', icon: <IconChat className="h-4 w-4" /> },
                { k: 'terminal', label: 'Terminale', icon: <IconTerminal className="h-4 w-4" /> },
              ] as const
            ).map(({ k, label, icon }) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`flex min-h-11 items-center justify-center gap-2 rounded-xl text-sm font-medium transition-colors ${
                  kind === k ? 'bg-accent text-black' : 'text-zinc-400'
                }`}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>

          {/* La chat usa OpenCode: avvisa se la CLI non è sul PATH */}
          {kind === 'chat' && !opencodeAvailable && (
            <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-xs leading-relaxed text-amber-200">
              OpenCode non trovato sul PATH. Installa la CLI con «npm install -g opencode-ai»
              per usare la chat (il terminale funziona comunque).
            </div>
          )}

          {/* Cartella */}
          <div>
            <div className="mb-1.5 text-xs font-medium text-zinc-400">Cartella di lavoro</div>
            <button
              onClick={() => setPickerOpen(true)}
              className="flex w-full min-h-12 items-center gap-3 rounded-2xl border border-white/5 bg-raised px-4 py-3 text-left"
            >
              <IconFolder className="h-5 w-5 shrink-0 text-accent" />
              {cwd ? (
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-zinc-100">{basename(cwd)}</span>
                  <span className="block truncate text-xs text-zinc-500">{cwd}</span>
                </span>
              ) : (
                <span className="flex-1 text-sm text-zinc-500">Scegli cartella…</span>
              )}
            </button>
          </div>

          {error && <div className="text-sm text-red-400">{error}</div>}

          <button
            onClick={() => void create()}
            disabled={!cwd || busy || (kind === 'chat' && !opencodeAvailable)}
            className="w-full rounded-2xl bg-accent py-3.5 text-sm font-semibold text-black active:opacity-80 disabled:opacity-40"
          >
            {busy ? 'Creazione…' : 'Crea sessione'}
          </button>
        </div>
      </Sheet>

      <FolderPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(path) => {
          setCwd(path);
          setPickerOpen(false);
        }}
      />
    </>
  );
}
