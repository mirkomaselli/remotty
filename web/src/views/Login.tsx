import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useStore } from '../store';
import { appAsset } from '../lib/base-path';

export default function Login() {
  const navigate = useNavigate();
  const authed = useStore((s) => s.authed);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (authed === true) navigate('/', { replace: true });
  }, [authed, navigate]);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(token.trim());
      useStore.getState().setAuthed(true);
      navigate('/', { replace: true });
    } catch {
      setError('Invalid token');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 pt-safe pb-safe">
      <img src={appAsset('icon.svg')} alt="" className="mb-5 h-16 w-16 rounded-2xl" />
      <h1 className="text-lg font-semibold text-zinc-100">remotty</h1>
      <p className="mt-1 mb-8 text-sm text-zinc-500">Enter your access token</p>
      <form onSubmit={submit} className="w-full max-w-sm space-y-3">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Token"
          autoFocus
          autoComplete="current-password"
          className="w-full rounded-2xl border border-white/5 bg-raised px-4 py-3.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-accent/50 focus:outline-none"
        />
        {error && <div className="px-1 text-sm text-red-400">{error}</div>}
        <button
          type="submit"
          disabled={!token.trim() || busy}
          className="w-full rounded-2xl bg-accent py-3.5 text-sm font-semibold text-black active:opacity-80 disabled:opacity-40"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
