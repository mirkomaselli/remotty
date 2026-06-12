import { useState } from 'react';
import type { ToolPart } from '../lib/chat-reducer';
import { stringifyInput, toolSummary } from '../lib/format';
import { IconChevronRight, IconWrench } from './icons';

const RESULT_TRUNCATE = 4096;

export default function ToolCard({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const isError = part.result?.isError === true;
  const summary = toolSummary(part.name, part.input);

  const content = part.result?.content ?? '';
  const truncated = !showAll && content.length > RESULT_TRUNCATE;
  const shown = truncated ? content.slice(0, RESULT_TRUNCATE) : content;

  return (
    <div
      className={`overflow-hidden rounded-xl border ${
        isError ? 'border-red-500/30 bg-red-500/5' : 'border-white/5 bg-raised'
      }`}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-h-11 items-center gap-2.5 px-3 py-2 text-left"
      >
        <IconWrench
          className={`h-4 w-4 shrink-0 ${isError ? 'text-red-400' : 'text-zinc-400'}`}
        />
        <span className="shrink-0 text-[13px] font-semibold text-zinc-200">{part.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-500">
          {summary}
        </span>
        {part.result === null && (
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400" />
        )}
        <IconChevronRight
          className={`h-4 w-4 shrink-0 text-zinc-600 transition-transform ${
            open ? 'rotate-90' : ''
          }`}
        />
      </button>

      {open && (
        <div className="space-y-2 border-t border-white/5 px-3 py-2.5">
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Input
            </div>
            <pre className="max-h-60 overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all text-zinc-300">
              {stringifyInput(part.input)}
            </pre>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Risultato
            </div>
            {part.result === null ? (
              <div className="text-xs text-zinc-500">in esecuzione…</div>
            ) : (
              <>
                <pre
                  className={`max-h-80 overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all ${
                    isError ? 'text-red-300' : 'text-zinc-300'
                  }`}
                >
                  {shown || '(vuoto)'}
                  {truncated ? '…' : ''}
                </pre>
                {content.length > RESULT_TRUNCATE && (
                  <button
                    onClick={() => setShowAll((v) => !v)}
                    className="mt-1.5 text-xs font-medium text-accent"
                  >
                    {showAll ? 'mostra meno' : 'mostra tutto'}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
