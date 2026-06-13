import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api } from './lib/api';
import { useStore } from './store';
import Login from './views/Login';
import Home from './views/Home';
import Chat from './views/Chat';
import Term from './views/Term';
import { appAsset } from './lib/base-path';
import { isNativeLocalShell } from './lib/native-pairing';
import NativeSetup from './views/NativeSetup';

export default function App() {
  const authed = useStore((s) => s.authed);
  const nativeSetup = isNativeLocalShell();

  // Probe iniziale: /api/auth/me decide login vs app. Su 401 il wrapper fetch
  // imposta authed=false; su errore di rete riprova finché il server risponde.
  useEffect(() => {
    if (nativeSetup) return;
    let dead = false;
    const probe = async (): Promise<void> => {
      try {
        await api.me();
        if (!dead) useStore.getState().setAuthed(true);
      } catch {
        if (!dead && useStore.getState().authed === null) setTimeout(() => void probe(), 2000);
      }
    };
    void probe();
    return () => {
      dead = true;
    };
  }, [nativeSetup]);

  // Config quando autenticati.
  useEffect(() => {
    if (authed !== true) return;
    api
      .config()
      .then((c) => useStore.getState().setConfig(c))
      .catch(() => {});
  }, [authed]);

  if (nativeSetup) return <NativeSetup />;

  if (authed === null) {
    return (
      <div className="grid h-full place-items-center">
        <div className="flex flex-col items-center gap-3">
          <img
            src={appAsset('icon.svg')}
            alt=""
            className="h-14 w-14 animate-pulse rounded-2xl"
          />
          <span className="text-xs text-zinc-600">connecting to server…</span>
        </div>
      </div>
    );
  }

  const guard = (el: ReactElement) => (authed ? el : <Navigate to="/login" replace />);

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={guard(<Home />)} />
      <Route path="/chat/:id" element={guard(<Chat />)} />
      <Route path="/term/:id" element={guard(<Term />)} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
