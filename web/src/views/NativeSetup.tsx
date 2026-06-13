import { useState } from 'react';
import { appAsset } from '../lib/base-path';
import { scanAndConnect } from '../lib/native-pairing';

export default function NativeSetup() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scan = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await scanAndConnect();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not scan the QR code.');
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 pt-safe pb-safe">
      <img src={appAsset('icon.svg')} alt="" className="mb-5 h-20 w-20 rounded-3xl" />
      <h1 className="text-xl font-semibold text-zinc-100">Connect to Remotty</h1>
      <p className="mt-2 mb-8 max-w-sm text-center text-sm leading-relaxed text-zinc-500">
        On your computer, open Remotty and choose “Connect Android app”, then scan the QR code.
      </p>
      <button
        type="button"
        onClick={() => void scan()}
        disabled={busy}
        className="w-full max-w-sm rounded-2xl bg-accent py-3.5 text-sm font-semibold text-black active:opacity-80 disabled:opacity-40"
      >
        {busy ? 'Opening camera...' : 'Scan QR code'}
      </button>
      {error && <div className="mt-4 max-w-sm text-center text-sm text-red-400">{error}</div>}
    </div>
  );
}
