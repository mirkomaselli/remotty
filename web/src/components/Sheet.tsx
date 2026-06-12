import type { ReactNode } from 'react';
import { IconX } from './icons';

interface SheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/** Bottom sheet generico: backdrop + pannello scuro con angoli arrotondati. */
export default function Sheet({ open, title, onClose, children }: SheetProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/60 fade-in" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-3xl border-t border-white/5 bg-surface pb-safe sheet-in">
        <div className="sticky top-0 z-10 flex items-center justify-between bg-surface px-5 pt-4 pb-2">
          <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
          <button
            onClick={onClose}
            className="grid h-11 w-11 place-items-center rounded-full text-zinc-400 active:bg-white/5"
            aria-label="Chiudi"
          >
            <IconX />
          </button>
        </div>
        <div className="px-5 pb-6">{children}</div>
      </div>
    </div>
  );
}
