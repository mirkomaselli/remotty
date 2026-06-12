import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { TermSocket } from '../lib/term-socket';
import { useStore, type ConnState } from '../store';
import { api } from '../lib/api';
import { basename } from '../lib/format';
import { IconChevronLeft } from '../components/icons';

const FONT_STACK =
  'ui-monospace, "SF Mono", Menlo, Consolas, "Cascadia Mono", monospace';

interface Key {
  label: string;
  seq?: string;
  ctrl?: boolean; // pulsante Ctrl sticky
}

const KEYS: Key[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: 'Ctrl', ctrl: true },
  { label: '^C', seq: '\x03' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
  { label: '/', seq: '/' },
  { label: '|', seq: '|' },
  { label: '-', seq: '-' },
  { label: '⏎', seq: '\r' },
];

export default function Term() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const sessions = useStore((s) => s.sessions);
  const meta = sessions.find((x) => x.id === id) ?? null;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const sockRef = useRef<TermSocket | null>(null);
  const ctrlRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [ctrl, setCtrlState] = useState(false);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined);
  const [cols, setCols] = useState(0);
  const [line, setLine] = useState('');
  const [histOpen, setHistOpen] = useState(false);
  const [hist, setHist] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('remotty-term-history');
      const v: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(v)
        ? v.filter((x): x is string => typeof x === 'string').slice(0, 50)
        : [];
    } catch {
      return [];
    }
  });

  // Invia la riga del composer al PTY come se fosse stata digitata + Invio.
  // Riga vuota = solo Invio (utile per confermare prompt).
  const sendLine = (): void => {
    const sock = sockRef.current;
    if (!sock || exitCode !== undefined) return;
    const text = line;
    sock.input(text + '\r');
    if (text.trim()) {
      setHist((h) => {
        const next = [text, ...h.filter((x) => x !== text)].slice(0, 50);
        try {
          localStorage.setItem('remotty-term-history', JSON.stringify(next));
        } catch {
          /* storage pieno/negato: la cronologia resta solo in memoria */
        }
        return next;
      });
    }
    setLine('');
    setHistOpen(false);
  };

  const setCtrl = (v: boolean): void => {
    ctrlRef.current = v;
    setCtrlState(v);
  };

  // Deep-link diretto a /term/:id: la lista sessioni può non essere ancora caricata.
  useEffect(() => {
    if (!id || meta) return;
    api
      .session(id)
      .then((m) => useStore.getState().upsertSession(m))
      .catch(() => {});
  }, [id, meta]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !id) return;

    const term = new Terminal({
      fontSize: 13,
      fontFamily: FONT_STACK,
      cursorBlink: true,
      scrollback: 5000,
      // Renderer DOM ovunque per v1: più semplice e sicuro su iOS (niente WebGL).
      theme: {
        background: '#0a0a0f',
        foreground: '#d4d4d8',
        cursor: '#34d399',
        cursorAccent: '#0a0a0f',
        selectionBackground: 'rgba(52,211,153,0.30)',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;

    const sock = new TermSocket(id, (e) => {
      switch (e.type) {
        case 'output':
          term.write(e.data);
          break;
        case 'snapshot':
          // Il server rimanda l'intero ring buffer ad OGNI attach (anche le
          // riconnessioni): reset prima del replay per non duplicare lo scrollback.
          term.reset();
          term.write(e.data);
          break;
        case 'exit':
          setExitCode(e.exitCode);
          sock.close(); // niente loop di riconnessione su sessione morta
          break;
        case 'conn':
          setConn(e.state);
          if (e.state === 'open') doFit(); // comunica subito la geometria reale
          break;
      }
    });
    sockRef.current = sock;

    const doFit = (): void => {
      try {
        fit.fit();
      } catch {
        return; // container non ancora misurabile
      }
      setCols(term.cols);
      sock.resize(term.cols, term.rows);
    };

    term.onData((d) => {
      // Ctrl sticky: il prossimo carattere singolo diventa Ctrl-<char>.
      if (ctrlRef.current && d.length === 1) {
        const code = d.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) {
          sock.input(String.fromCharCode(code & 31));
          setCtrl(false);
          return;
        }
        setCtrl(false);
      }
      sock.input(d);
    });

    doFit();
    // Niente focus automatico su xterm: l'input primario è il composer in basso;
    // un tap sul terminale attiva comunque la scrittura diretta (TUI, password).

    // Fit con debounce su resize finestra e visualViewport (tastiera mobile).
    let t: ReturnType<typeof setTimeout> | undefined;
    const onResize = (): void => {
      if (t !== undefined) clearTimeout(t);
      t = setTimeout(doFit, 150);
    };
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(el);

    return () => {
      if (t !== undefined) clearTimeout(t);
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      ro.disconnect();
      sock.close();
      sockRef.current = null;
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const press = (k: Key): void => {
    const term = termRef.current;
    if (!term) return;
    if (k.ctrl) {
      setCtrl(!ctrlRef.current);
      return;
    }
    if (k.seq) term.input(k.seq); // passa da onData → trasformazione Ctrl inclusa
  };

  return (
    <div className="flex h-dvh flex-col bg-app pt-safe">
      {/* Header */}
      <header className="flex items-center gap-1 border-b border-white/5 px-1 py-1">
        <button
          onClick={() => navigate('/')}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-zinc-300 active:bg-white/5"
          aria-label="Indietro"
        >
          <IconChevronLeft />
        </button>
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-zinc-100">
            {meta?.title || (meta ? basename(meta.cwd) : 'Terminale')}
          </span>
        </div>
        <span
          className={`mr-3 h-2 w-2 shrink-0 rounded-full ${
            exitCode !== undefined
              ? 'bg-zinc-600'
              : conn === 'open'
                ? 'bg-emerald-400'
                : 'bg-amber-400 animate-pulse'
          }`}
        />
      </header>

      {cols > 0 && cols < 60 && exitCode === undefined && (
        <div className="bg-amber-400/10 px-4 py-1 text-center text-[11px] text-amber-300">
          Schermo stretto ({cols} col): le TUI come Claude Code richiedono ≥80 colonne
        </div>
      )}

      {/* xterm full-bleed */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={containerRef} className="h-full w-full pl-2" />
        {exitCode !== undefined && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/70 backdrop-blur-sm">
            <div className="text-sm text-zinc-200">
              Processo terminato{exitCode !== null ? ` (exit ${exitCode})` : ''}
            </div>
            <button
              onClick={() => navigate('/')}
              className="rounded-2xl bg-accent px-6 py-3 text-sm font-semibold text-black active:opacity-80"
            >
              Torna alla home
            </button>
          </div>
        )}
      </div>

      {/* Barra extra-keys sopra la tastiera */}
      <div className="flex gap-1.5 overflow-x-auto border-t border-white/5 bg-surface px-2 py-1.5">
        {KEYS.map((k) => (
          <button
            key={k.label}
            // pointerdown + preventDefault: mantiene il focus dov'è (xterm o composer)
            onPointerDown={(e) => {
              e.preventDefault();
              press(k);
            }}
            className={`min-h-10 shrink-0 rounded-lg border px-3.5 font-mono text-[13px] active:opacity-70 ${
              k.ctrl && ctrl
                ? 'border-accent/60 bg-accent/20 text-accent'
                : 'border-white/10 bg-raised text-zinc-300'
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>

      {/* Composer: input nativo (editing/cursore/incolla comodi da mobile),
          la riga viene inviata al PTY con Invio. Toccando xterm si può sempre
          scrivere in modo diretto (TUI, password prompt, ecc.). */}
      <div
        className="relative border-t border-white/5 bg-surface px-2 pt-1.5"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.375rem)' }}
      >
        {histOpen && hist.length > 0 && (
          <div className="absolute inset-x-2 bottom-full z-20 mb-1 max-h-48 overflow-y-auto rounded-xl border border-white/10 bg-surface shadow-xl">
            {hist.map((c) => (
              <button
                key={c}
                onClick={() => {
                  setLine(c);
                  setHistOpen(false);
                  inputRef.current?.focus();
                }}
                className="block w-full truncate border-b border-white/5 px-3 py-2.5 text-left font-mono text-[12px] text-zinc-300 last:border-b-0 active:bg-white/5"
              >
                {c}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setHistOpen((v) => !v)}
            disabled={exitCode !== undefined || hist.length === 0}
            className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl border text-base active:opacity-70 disabled:opacity-30 ${
              histOpen
                ? 'border-accent/60 bg-accent/20 text-accent'
                : 'border-white/10 bg-raised text-zinc-400'
            }`}
            aria-label="Cronologia comandi"
          >
            ↺
          </button>
          <input
            ref={inputRef}
            value={line}
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                sendLine();
              }
            }}
            disabled={exitCode !== undefined}
            placeholder="Comando… (vuoto = Invio)"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="send"
            // 16px: sotto questa soglia iOS Safari zooma la pagina al focus
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-raised px-3 font-mono text-[16px] text-zinc-100 placeholder:font-sans placeholder:text-[13px] placeholder:text-zinc-500 focus:border-accent/50 focus:outline-none disabled:opacity-30"
          />
          <button
            onClick={sendLine}
            disabled={exitCode !== undefined}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent text-base font-semibold text-black active:opacity-80 disabled:opacity-30"
            aria-label="Invia"
          >
            ➤
          </button>
        </div>
      </div>
    </div>
  );
}
