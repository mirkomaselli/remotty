// Smoke test end-to-end: avvia il server compilato, verifica REST + WS
// (terminale e chat) e la web app statica, poi termina il processo.
//
//   node scripts/smoke.mjs
//
// Non invia mai user_message alla chat: l'attach è lazy e non avvia alcun
// processo agente, quindi il test gira anche senza OpenCode installato.

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = Number(process.env.SMOKE_PORT || 7710);
const BASE = `http://localhost:${PORT}`;
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_CWD = REPO_ROOT.replace(/[\\/]+$/, '');

const TERM_OP = { INPUT: 0x30, RESIZE: 0x31, OUTPUT: 0x30, SNAPSHOT: 0x32, EXIT: 0x33 };

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
  return { status: res.status, headers: res.headers, data };
}

function wsConnect(sessionId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/api/sessions/${sessionId}/ws`);
    ws.binaryType = 'nodebuffer';
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

/** Attende il prossimo messaggio WS che soddisfa pred (o il primo se pred manca). */
function waitFor(ws, pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${label}`));
    }, timeoutMs);
    const onMsg = (data) => {
      let match;
      try {
        match = pred ? pred(data) : true;
      } catch {
        match = false;
      }
      if (match) {
        cleanup();
        resolve(data);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`socket closed while waiting for ${label}`));
    };
    const cleanup = () => {
      clearTimeout(t);
      ws.off('message', onMsg);
      ws.off('close', onClose);
    };
    ws.on('message', onMsg);
    ws.on('close', onClose);
  });
}

// ---------------------------------------------------------------------------

let server = null;

function killServer() {
  if (!server || server.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    server.kill('SIGTERM');
  }
}

async function startServer() {
  server = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'dist', 'index.js')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      REMOTTY_DATA_DIR: path.join(REPO_ROOT, 'data-smoke'),
      REMOTTY_AUTH_TOKEN: '', // auth disabilitata
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  // Attendi che /api/health risponda.
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`server exited early (${server.exitCode})`);
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* non ancora pronto */
    }
    if (Date.now() > deadline) throw new Error('server did not become healthy in 20s');
    await sleep(250);
  }
}

async function main() {
  await startServer();

  // (a) health
  const health = await json('GET', '/api/health');
  assert(health.status === 200 && health.data?.ok === true, 'a. GET /api/health', `version=${health.data?.version}`);

  // (b) config
  const cfg = await json('GET', '/api/config');
  assert(cfg.status === 200 && typeof cfg.data?.clis?.opencode === 'boolean', 'b. GET /api/config clis', JSON.stringify(cfg.data?.clis));

  // (c) fs browse: roots, poi dentro una root
  const roots = await json('GET', '/api/fs/browse');
  assert(roots.status === 200 && Array.isArray(roots.data?.dirs) && roots.data.dirs.length > 0, 'c. browse roots non vuoto', `${roots.data?.dirs?.length} roots`);
  const firstRoot = roots.data.dirs[0].path;
  const sub = await json('GET', `/api/fs/browse?path=${encodeURIComponent(firstRoot)}`);
  assert(sub.status === 200 && Array.isArray(sub.data?.dirs), 'c. browse dentro una root', `${firstRoot} → ${sub.data?.dirs?.length} dirs`);

  // (d) sessione terminale + WS binario
  const term = await json('POST', '/api/sessions', { kind: 'terminal', cwd: TEST_CWD });
  assert(term.status === 201 && typeof term.data?.id === 'string', 'd. POST sessione terminal', `id=${term.data?.id}`);
  const termId = term.data.id;

  const tws = await wsConnect(termId);
  try {
    const first = await waitFor(tws, (d) => Buffer.isBuffer(d) && d.length >= 1, 10_000, 'primo frame');
    assert(first[0] === TERM_OP.SNAPSHOT, 'd. primo frame = SNAPSHOT (0x32)', `opcode=0x${first[0].toString(16)}`);

    // Aspetta che l'output raggiunga 'remotty_smoke_ok' (echo del comando incluso: ok).
    const outputSeen = waitFor(
      tws,
      (d) => Buffer.isBuffer(d) && d[0] === TERM_OP.OUTPUT && d.subarray(1).toString('utf8').includes('remotty_smoke_ok'),
      10_000,
      "OUTPUT contenente 'remotty_smoke_ok'",
    );
    tws.send(Buffer.concat([Buffer.from([TERM_OP.INPUT]), Buffer.from('echo remotty_smoke_ok\r\n', 'utf8')]));
    await outputSeen;
    record('d. OUTPUT contiene remotty_smoke_ok', true);

    // RESIZE: non deve causare errori né chiusura.
    let closedAfterResize = false;
    const onUnexpectedClose = () => {
      closedAfterResize = true;
    };
    tws.on('close', onUnexpectedClose);
    tws.send(Buffer.concat([Buffer.from([TERM_OP.RESIZE]), Buffer.from(JSON.stringify({ cols: 90, rows: 28 }), 'utf8')]));
    await sleep(700); // copre il debounce resize (250 ms) + eventuale errore async
    tws.off('close', onUnexpectedClose);
    assert(!closedAfterResize && tws.readyState === WebSocket.OPEN, 'd. RESIZE senza errori/chiusura');
  } finally {
    try {
      tws.close();
    } catch {
      /* ignore */
    }
  }
  const delTerm = await json('DELETE', `/api/sessions/${termId}`);
  assert(delTerm.status === 204, 'd. DELETE sessione terminal → 204', `status=${delTerm.status}`);

  // (e) sessione chat: solo attach (MAI user_message: avvierebbe l'agente).
  const chat = await json('POST', '/api/sessions', { kind: 'chat', cwd: TEST_CWD, agent: 'opencode' });
  assert(chat.status === 201 && chat.data?.status === 'created', 'e. POST sessione chat → created', `status=${chat.data?.status}`);
  const chatId = chat.data.id;

  const cws = await wsConnect(chatId);
  try {
    const attachedSeen = waitFor(
      cws,
      (d) => {
        try {
          return JSON.parse(d.toString('utf8')).type === 'attached';
        } catch {
          return false;
        }
      },
      10_000,
      "frame 'attached'",
    );
    cws.send(JSON.stringify({ type: 'attach', afterSeq: 0 }));
    const attachedRaw = await attachedSeen;
    const attached = JSON.parse(attachedRaw.toString('utf8'));
    assert(attached.type === 'attached' && attached.lastSeq === 0, 'e. attach → attached lastSeq=0', `lastSeq=${attached.lastSeq}`);
  } finally {
    try {
      cws.close();
    } catch {
      /* ignore */
    }
  }
  const delChat = await json('DELETE', `/api/sessions/${chatId}`);
  assert(delChat.status === 204, 'e. DELETE sessione chat → 204', `status=${delChat.status}`);

  // (f) web app statica
  const home = await fetch(`${BASE}/`);
  const ct = home.headers.get('content-type') || '';
  assert(home.status === 200 && ct.includes('text/html'), 'f. GET / → 200 text/html', `status=${home.status} ct=${ct}`);
}

main()
  .catch((err) => {
    failed = true;
    console.error('SMOKE FAILURE:', err.message);
  })
  .finally(() => {
    killServer();
    console.log('\n=== SMOKE SUMMARY ===');
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.step}`);
    console.log(failed ? 'RESULT: FAIL' : 'RESULT: OK');
    process.exit(failed ? 1 : 0);
  });
