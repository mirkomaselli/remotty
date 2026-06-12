// Smoke test e2e dell'adapter OpenCode: avvia il server compilato, crea una
// sessione chat agent='opencode', invia un prompt reale (provider gratuito
// "opencode" incluso di serie — zero costi) e verifica l'intero flusso eventi:
// echo, running, testo, result, idle, replay lossless, delete.
//
//   node scripts/smoke-opencode.mjs

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = Number(process.env.SMOKE_PORT || 7710);
const BASE = `http://localhost:${PORT}`;
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_CWD = REPO_ROOT.replace(/[\\/]+$/, '');
const DATA_DIR = path.join(TEST_CWD, 'data-smoke-oc');

const results = [];
let failed = false;

function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

function assert(cond, step, detail) {
  if (cond) record(step, true, detail);
  else {
    record(step, false, detail);
    throw new Error(`assertion failed: ${step}${detail ? ` (${detail})` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: res.status, data };
}

function wsConnect(sessionId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/api/sessions/${sessionId}/ws`);
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 10_000);
    ws.once('open', () => {
      clearTimeout(t);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

/** Colleziona envelope finché pred(events) è vera o scade il timeout. */
function collectUntil(ws, events, pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timeout waiting for ${label} (visti ${events.length} eventi)`));
    }, timeoutMs);
    const onMsg = (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      events.push(msg);
      if (pred(events)) {
        clearTimeout(t);
        ws.off('message', onMsg);
        resolve(events);
      }
    };
    ws.on('message', onMsg);
  });
}

const envelopes = (events) => events.filter((m) => typeof m.seq === 'number').map((m) => m.ev);
const hasEv = (events, type) => envelopes(events).some((e) => e.type === type);
const lastSeqOf = (events) =>
  Math.max(0, ...events.filter((m) => typeof m.seq === 'number').map((m) => m.seq));
const evsAfter = (events, seq) =>
  events.filter((m) => typeof m.seq === 'number' && m.seq > seq).map((m) => m.ev);

async function main() {
  // 1. avvia il server
  const server = spawn(process.execPath, [path.join(TEST_CWD, 'server', 'dist', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), REMOTTY_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server!] ${d}`));

  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      await sleep(200);
      try {
        const r = await fetch(`${BASE}/api/health`);
        up = r.ok;
      } catch {
        /* not yet */
      }
    }
    assert(up, 'server avviato');

    // 2. config rileva opencode
    const cfg = await json('GET', '/api/config');
    assert(cfg.data?.clis?.opencode === true, 'config: opencode rilevato sul PATH');

    // 3. crea sessione chat opencode
    const created = await json('POST', '/api/sessions', {
      kind: 'chat',
      cwd: TEST_CWD,
      agent: 'opencode',
    });
    assert(
      created.status === 201 && created.data?.agent === 'opencode',
      'POST sessione chat opencode',
      `status=${created.status}`,
    );
    const id = created.data.id;

    // 4. attach + prompt reale
    const ws = await wsConnect(id);
    const events = [];
    ws.send(JSON.stringify({ type: 'attach', afterSeq: 0 }));
    await collectUntil(ws, events, (ev) => ev.some((m) => m.type === 'attached'), 10_000, 'attached');
    record('attach → attached', true);

    ws.send(
      JSON.stringify({
        type: 'user_message',
        text: 'Rispondi solo con la parola: pronto. Non usare alcun tool.',
      }),
    );
    // Primo avvio: spawn di `opencode serve` + chiamata al modello gratuito.
    // Lo status idle viene emesso subito DOPO result: aspetta quello.
    await collectUntil(
      ws,
      events,
      (ev) =>
        envelopes(ev).some((e) => e.type === 'status' && e.status === 'idle') ||
        hasEv(ev, 'error'),
      120_000,
      'status idle / error',
    );

    const evs = envelopes(events);
    assert(hasEv(events, 'user_message'), 'echo user_message ricevuto');
    const errors = evs.filter((e) => e.type === 'error');
    assert(errors.length === 0, 'nessun evento error', errors.map((e) => e.message).join(' | '));
    const text =
      evs
        .filter((e) => e.type === 'assistant_message')
        .flatMap((e) => e.blocks)
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ') || evs.filter((e) => e.type === 'text_delta').map((e) => e.text).join('');
    assert(text.length > 0, 'testo assistente ricevuto', JSON.stringify(text.slice(0, 80)));
    const result = evs.find((e) => e.type === 'result');
    assert(result && !result.isError, 'evento result ok', `subtype=${result?.subtype} durata=${result?.durationMs}ms`);
    const lastStatus = evs.filter((e) => e.type === 'status').at(-1);
    assert(lastStatus?.status === 'idle', 'status finale idle', lastStatus?.status);

    // 5. meta persistita con opencodeSessionId
    const meta = await json('GET', `/api/sessions/${id}`);
    assert(
      typeof meta.data?.opencodeSessionId === 'string' && meta.data.opencodeSessionId.startsWith('ses'),
      'meta.opencodeSessionId persistito',
      meta.data?.opencodeSessionId,
    );

    // 6. lista modelli per il picker
    const modelsRes = await json('GET', `/api/opencode/models?cwd=${encodeURIComponent(TEST_CWD)}`);
    const providers = modelsRes.data?.providers ?? [];
    assert(
      modelsRes.status === 200 && providers.length > 0 && providers[0].models.length > 0,
      'GET /api/opencode/models',
      `providers=${providers.map((p) => p.id).join(',')}`,
    );

    // 7. set_model: formato invalido → error; valido → meta.opencodeModel
    let cut = lastSeqOf(events);
    ws.send(JSON.stringify({ type: 'set_model', model: 'senza-slash' }));
    await collectUntil(
      ws,
      events,
      (ev) => evsAfter(ev, cut).some((e) => e.type === 'error'),
      10_000,
      'error per set_model invalido',
    );
    record('set_model invalido → error', true);

    const prov = providers[0];
    const modelValue = `${prov.id}/${prov.defaultModelID ?? prov.models[0].id}`;
    cut = lastSeqOf(events);
    ws.send(JSON.stringify({ type: 'set_model', model: modelValue }));
    await collectUntil(
      ws,
      events,
      (ev) => evsAfter(ev, cut).some((e) => e.type === 'meta' && e.meta?.opencodeModel === modelValue),
      10_000,
      'meta con opencodeModel',
    );
    record('set_model valido → meta.opencodeModel', true, modelValue);

    // 8. clear vero: nuova sessione opencode al posto della vecchia
    const prevOcId = meta.data.opencodeSessionId;
    cut = lastSeqOf(events);
    ws.send(JSON.stringify({ type: 'clear_context' }));
    await collectUntil(
      ws,
      events,
      (ev) => evsAfter(ev, cut).some((e) => e.type === 'notice'),
      15_000,
      'notice post-clear',
    );
    const metaAfterClear = await json('GET', `/api/sessions/${id}`);
    assert(
      typeof metaAfterClear.data?.opencodeSessionId === 'string' &&
        metaAfterClear.data.opencodeSessionId !== prevOcId,
      'clear_context → nuova sessione opencode',
      `${prevOcId} → ${metaAfterClear.data?.opencodeSessionId}`,
    );

    // 9. turno dopo il clear (usa il modello selezionato col picker)
    cut = lastSeqOf(events);
    ws.send(
      JSON.stringify({
        type: 'user_message',
        text: 'Rispondi solo con la parola: ok. Non usare alcun tool.',
      }),
    );
    await collectUntil(
      ws,
      events,
      (ev) =>
        evsAfter(ev, cut).some(
          (e) => (e.type === 'status' && e.status === 'idle') || e.type === 'error',
        ),
      120_000,
      'idle post-clear',
    );
    const postClearErrors = evsAfter(events, cut).filter((e) => e.type === 'error');
    assert(
      postClearErrors.length === 0,
      'turno post-clear senza errori',
      postClearErrors.map((e) => e.message).join(' | '),
    );

    // 10. compact: notice + summarize fino a idle
    cut = lastSeqOf(events);
    ws.send(JSON.stringify({ type: 'compact_context' }));
    await collectUntil(
      ws,
      events,
      (ev) =>
        evsAfter(ev, cut).some(
          (e) => (e.type === 'status' && e.status === 'idle') || e.type === 'error',
        ),
      120_000,
      'idle post-compact',
    );
    const compactEvs = evsAfter(events, cut);
    const compactErrors = compactEvs.filter((e) => e.type === 'error');
    assert(
      compactErrors.length === 0,
      'compact_context senza errori',
      compactErrors.map((e) => e.message).join(' | '),
    );
    assert(compactEvs.some((e) => e.type === 'notice'), 'compact_context → notice');

    // 11. replay lossless da una seconda connessione
    const ws2 = await wsConnect(id);
    const replay = [];
    ws2.send(JSON.stringify({ type: 'attach', afterSeq: 0 }));
    await collectUntil(ws2, replay, (ev) => ev.some((m) => m.type === 'attached'), 10_000, 'replay attached');
    const liveSeqs = events.filter((m) => typeof m.seq === 'number').length;
    const replaySeqs = replay.filter((m) => typeof m.seq === 'number').length;
    assert(replaySeqs >= liveSeqs, 'replay completo', `live=${liveSeqs} replay=${replaySeqs}`);
    ws2.close();
    ws.close();

    // 12. delete
    const del = await json('DELETE', `/api/sessions/${id}`);
    assert(del.status === 204, 'DELETE sessione → 204', `status=${del.status}`);
  } catch (err) {
    record('eccezione', false, err.message);
  } finally {
    if (server.pid) {
      spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    }
    await sleep(500);
    try {
      rmSync(DATA_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log('\n=== SMOKE OPENCODE SUMMARY ===');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.step}`);
  console.log(`RESULT: ${failed ? 'FAILED' : 'OK'}`);
  process.exit(failed ? 1 : 0);
}

main();
