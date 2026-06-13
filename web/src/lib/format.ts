import type { SessionStatus } from '@remotty/shared';

/** Basename cross-separatore (il server può girare su Windows o macOS). */
export function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : trimmed || p;
}

export function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return '';
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}

export function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

/** Riassunto a una riga per la card di un tool_use. */
export function toolSummary(name: string, input: unknown): string {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (name === 'Bash' && typeof obj['command'] === 'string') return obj['command'];
  const fp = obj['file_path'] ?? obj['path'] ?? obj['notebook_path'];
  if (typeof fp === 'string' && fp.length > 0) return fp;
  if (typeof obj['pattern'] === 'string') return obj['pattern'];
  if (typeof obj['url'] === 'string') return obj['url'];
  try {
    const j = JSON.stringify(input) ?? '';
    return j.length > 60 ? `${j.slice(0, 60)}…` : j;
  } catch {
    return '';
  }
}

export function stringifyInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}

export const STATUS_LABEL: Record<SessionStatus, string> = {
  created: 'new',
  running: 'running',
  waiting_permission: 'permission',
  waiting_input: 'question',
  idle: 'ready',
  exited: 'exited',
  error: 'error',
};

export const STATUS_DOT: Record<SessionStatus, string> = {
  created: 'bg-zinc-500',
  running: 'bg-emerald-400',
  waiting_permission: 'bg-amber-400',
  waiting_input: 'bg-sky-400',
  idle: 'bg-sky-400',
  exited: 'bg-zinc-600',
  error: 'bg-red-500',
};

export const STATUS_BADGE: Record<SessionStatus, string> = {
  created: 'bg-zinc-500/15 text-zinc-400',
  running: 'bg-emerald-400/15 text-emerald-300',
  waiting_permission: 'bg-amber-400/15 text-amber-300',
  waiting_input: 'bg-sky-400/15 text-sky-300',
  idle: 'bg-sky-400/15 text-sky-300',
  exited: 'bg-zinc-500/15 text-zinc-500',
  error: 'bg-red-500/15 text-red-400',
};
