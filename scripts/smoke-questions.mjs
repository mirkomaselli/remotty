import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

const APP_PORT = Number(process.env.SMOKE_PORT || 7813);
const OC_PORT = Number(process.env.SMOKE_OPENCODE_PORT || 7814);
const BASE = `http://127.0.0.1:${APP_PORT}`;
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA_DIR = path.join(REPO_ROOT, 'data-smoke-questions');
const results = [];
let failed = false;
let app = null;
let promptCount = 0;
const promptBodies = [];
let replyBody = null;
let rejectSeen = false;
const sseClients = new Set();

function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

function assert(condition, step, detail) {
  if (!condition) throw new Error(`${step}${detail ? ` (${detail})` : ''}`);
  record(step, true, detail);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : null;
}

function emit(type, properties) {
  const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of sseClients) res.write(frame);
}

const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${OC_PORT}`);
  if (req.method === 'GET' && url.pathname === '/global/health') {
    json(res, 200, { healthy: true });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/config/providers') {
    json(res, 200, {
      providers: [
        {
          id: 'mock',
          name: 'Mock',
          models: {
            textonly: {
              id: 'textonly',
              name: 'Text only',
              capabilities: {
                input: {
                  text: true,
                  audio: false,
                  image: false,
                  video: false,
                  pdf: false,
                },
              },
            },
          },
        },
      ],
      default: {},
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/session') {
    json(res, 200, { id: 'ses_mock_questions' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/event') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (
    req.method === 'POST' &&
    url.pathname === '/session/ses_mock_questions/prompt_async'
  ) {
    promptBodies.push(await readJson(req));
    promptCount += 1;
    res.writeHead(204).end();
    const requestID = promptCount === 1 ? 'que_answer' : 'que_reject';
    setTimeout(() => {
      emit('question.asked', {
        id: requestID,
        sessionID: 'ses_mock_questions',
        questions: [
          {
            header: 'Environment',
            question: 'Which environment should be used?',
            options: [
              { label: 'Staging', description: 'Use the staging environment' },
              { label: 'Production', description: 'Use the production environment' },
            ],
            multiple: false,
            custom: true,
          },
          {
            header: 'Checks',
            question: 'Which checks should run?',
            options: [
              { label: 'Unit', description: 'Run unit tests' },
              { label: 'Smoke', description: 'Run smoke tests' },
            ],
            multiple: true,
            custom: true,
          },
        ],
      });
    }, 100);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/question/que_answer/reply') {
    replyBody = await readJson(req);
    json(res, 200, true);
    setTimeout(() => {
      emit('question.replied', {
        sessionID: 'ses_mock_questions',
        requestID: 'que_answer',
        answers: replyBody.answers,
      });
      emit('session.idle', { sessionID: 'ses_mock_questions' });
    }, 50);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/question/que_reject/reject') {
    rejectSeen = true;
    json(res, 200, true);
    setTimeout(() => {
      emit('question.rejected', {
        sessionID: 'ses_mock_questions',
        requestID: 'que_reject',
      });
      emit('session.idle', { sessionID: 'ses_mock_questions' });
    }, 50);
    return;
  }
  if (req.method === 'DELETE' && url.pathname === '/session/ses_mock_questions') {
    res.writeHead(204).end();
    return;
  }
  json(res, 404, { error: `${req.method} ${url.pathname}` });
});

function waitForWs(ws, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${label}`));
    }, timeoutMs);
    const onMessage = (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
    };
    ws.on('message', onMessage);
  });
}

async function waitHealthy() {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      // not ready
    }
    await sleep(100);
  }
  throw new Error('remotty did not become healthy');
}

async function createSession() {
  const res = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'chat', cwd: REPO_ROOT, agent: 'opencode' }),
  });
  if (!res.ok) throw new Error(`create session HTTP ${res.status}`);
  return res.json();
}

function connect(sessionID) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${APP_PORT}/api/sessions/${sessionID}/ws`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function killApp() {
  if (!app || app.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    app.kill('SIGTERM');
  }
}

async function main() {
  await new Promise((resolve) => mock.listen(OC_PORT, '127.0.0.1', resolve));
  app = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'dist', 'index.js')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      HOST: '127.0.0.1',
      REMOTTY_OPENCODE_PORT: String(OC_PORT),
      REMOTTY_DATA_DIR: DATA_DIR,
      REMOTTY_AUTH_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', (data) => process.stdout.write(`[server] ${data}`));
  app.stderr.on('data', (data) => process.stderr.write(`[server!] ${data}`));

  await waitHealthy();
  const session = await createSession();
  const ws = await connect(session.id);
  ws.send(JSON.stringify({ type: 'attach', afterSeq: 0 }));
  await waitForWs(ws, (message) => message.type === 'attached', 10_000, 'attached');

  const modelSelected = waitForWs(
    ws,
    (message) =>
      message.ev?.type === 'meta' && message.ev.meta?.opencodeModel === 'mock/textonly',
    10_000,
    'text-only model selected',
  );
  ws.send(JSON.stringify({ type: 'set_model', model: 'mock/textonly' }));
  await modelSelected;
  const unsupported = waitForWs(
    ws,
    (message) =>
      message.ev?.type === 'error' &&
      message.ev.message.includes('does not support images'),
    10_000,
    'unsupported image error',
  );
  ws.send(
    JSON.stringify({
      type: 'user_message',
      text: 'inspect image',
      attachments: [
        {
          name: 'pixel.png',
          mime: 'image/png',
          size: 1,
          dataUrl: 'data:image/png;base64,AA==',
        },
      ],
    }),
  );
  await unsupported;
  assert(promptCount === 0, 'blocks unsupported attachments before prompt_async');
  const modelReset = waitForWs(
    ws,
    (message) => message.ev?.type === 'meta' && message.ev.meta?.opencodeModel === null,
    10_000,
    'model reset',
  );
  ws.send(JSON.stringify({ type: 'set_model', model: null }));
  await modelReset;

  const userEcho = waitForWs(
    ws,
    (message) => message.ev?.type === 'user_message',
    10_000,
    'user_message attachment echo',
  );
  ws.send(
    JSON.stringify({
      type: 'user_message',
      text: 'ask me',
      attachments: [
        {
          name: 'screen.txt',
          mime: 'text/plain',
          size: 5,
          dataUrl: 'data:text/plain;base64,aGVsbG8=',
        },
      ],
    }),
  );
  const echoed = await userEcho;
  assert(
    JSON.stringify(echoed.ev.attachments) ===
      JSON.stringify([{ name: 'screen.txt', mime: 'text/plain', size: 5 }]),
    'persists attachment metadata only',
  );
  const request = await waitForWs(
    ws,
    (message) => message.ev?.type === 'question_request',
    10_000,
    'question_request',
  );
  assert(request.ev.questions.length === 2, 'maps multiple questions');
  assert(
    JSON.stringify(promptBodies[0]?.parts) ===
      JSON.stringify([
        { type: 'text', text: 'ask me' },
        {
          type: 'file',
          mime: 'text/plain',
          filename: 'screen.txt',
          url: 'data:text/plain;base64,aGVsbG8=',
        },
      ]),
    'forwards file part to prompt_async',
  );
  const waiting = await waitForWs(
    ws,
    (message) => message.ev?.type === 'status' && message.ev.status === 'waiting_input',
    10_000,
    'waiting_input',
  );
  assert(waiting.ev.status === 'waiting_input', 'sets waiting_input status');

  const resolvedAnswer = waitForWs(
    ws,
    (message) =>
      message.ev?.type === 'question_resolved' &&
      message.ev.requestId === 'que_answer',
    10_000,
    'answered question_resolved',
  );
  ws.send(
    JSON.stringify({
      type: 'question_response',
      requestId: 'que_answer',
      answers: [['Staging'], ['Unit', 'Smoke', 'Lint']],
    }),
  );
  await resolvedAnswer;
  assert(
    JSON.stringify(replyBody) ===
      JSON.stringify({ answers: [['Staging'], ['Unit', 'Smoke', 'Lint']] }),
    'forwards ordered answers',
    JSON.stringify(replyBody),
  );

  ws.send(JSON.stringify({ type: 'user_message', text: 'ask again' }));
  await waitForWs(
    ws,
    (message) =>
      message.ev?.type === 'question_request' && message.ev.requestId === 'que_reject',
    10_000,
    'second question_request',
  );
  const resolvedReject = waitForWs(
    ws,
    (message) =>
      message.ev?.type === 'question_resolved' &&
      message.ev.requestId === 'que_reject' &&
      message.ev.outcome === 'rejected',
    10_000,
    'rejected question_resolved',
  );
  ws.send(JSON.stringify({ type: 'question_reject', requestId: 'que_reject' }));
  await resolvedReject;
  assert(rejectSeen, 'forwards question rejection');

  ws.close();
}

main()
  .catch((error) => {
    failed = true;
    record('exception', false, error.message);
  })
  .finally(async () => {
    killApp();
    for (const res of sseClients) res.end();
    await new Promise((resolve) => mock.close(resolve));
    rmSync(DATA_DIR, { recursive: true, force: true });
    console.log('\n=== SMOKE QUESTIONS SUMMARY ===');
    for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.step}`);
    console.log(failed ? 'RESULT: FAIL' : 'RESULT: OK');
    process.exit(failed ? 1 : 0);
  });
