import { useEffect } from 'react';

// Tipizzazione difensiva: navigator.wakeLock non è garantito da lib.dom su
// tutte le versioni TS e comunque va feature-detected (assente su HTTP LAN).
interface WakeLockSentinelLike {
  release(): Promise<void>;
}
type NavWithWakeLock = Navigator & {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
};

/** Mantiene lo schermo acceso finché `active` è true; riacquisisce al ritorno in foreground. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    const nav = navigator as NavWithWakeLock;
    if (!active || !nav.wakeLock) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let dead = false;

    const acquire = async (): Promise<void> => {
      try {
        const s = await nav.wakeLock!.request('screen');
        if (dead) await s.release();
        else sentinel = s;
      } catch {
        /* negato (batteria, ecc.): non bloccante */
      }
    };
    const onVis = (): void => {
      // Il lock viene rilasciato dal sistema quando la pagina va in background.
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      dead = true;
      document.removeEventListener('visibilitychange', onVis);
      sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}
