import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../lib/api';
import Sheet from './Sheet';

export default function PairDeviceSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setQr(null);
    setError(null);
    api
      .pairing()
      .then(async (pairing) => {
        const image = await QRCode.toDataURL(JSON.stringify(pairing), {
          width: 640,
          margin: 2,
          errorCorrectionLevel: 'M',
          color: { dark: '#09090b', light: '#ffffff' },
        });
        if (!cancelled) {
          setServerUrl(pairing.serverUrl);
          setQr(image);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'Could not create pairing code.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Sheet open={open} onClose={onClose} title="Connect Android app">
      <div className="text-center">
        <p className="mb-4 text-sm leading-relaxed text-zinc-400">
          Open Remotty on Android and scan this code. It contains the server address and access
          token, so do not share it.
        </p>
        {qr && (
          <img
            src={qr}
            alt="Remotty Android pairing QR code"
            className="mx-auto w-full max-w-72 rounded-2xl bg-white p-2"
          />
        )}
        {!qr && !error && (
          <div className="mx-auto grid aspect-square w-full max-w-72 place-items-center rounded-2xl bg-raised text-sm text-zinc-500">
            Creating code...
          </div>
        )}
        {error && <div className="rounded-xl bg-red-500/10 p-3 text-sm text-red-400">{error}</div>}
        {serverUrl && <div className="mt-3 break-all text-xs text-zinc-600">{serverUrl}</div>}
      </div>
    </Sheet>
  );
}
