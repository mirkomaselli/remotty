# remotty — Architecture

Self-hosted web app that runs on the dev machine (Windows 11 or macOS ARM) and is accessed
from a phone browser (LAN or Tailscale). It wraps terminal coding agents — OpenCode — in a
mobile-first chat UI, with project/folder browsing and a real terminal fallback.

**Hard constraints (non-negotiable):**

1. **No API keys, ever.** Everything goes through the locally installed CLI binaries and the
   user's existing logins (`opencode auth login`).
2. **Cross-platform host**: Windows 11 (primary, Node 24) and macOS Apple Silicon. No
   platform-only dependencies without prebuilt binaries for `win32-x64` and `darwin-arm64`.
3. **Chat UI is NOT built by scraping a PTY.** Chat = structured event stream from the agent
   (OpenCode HTTP + SSE). PTY (ConPTY/forkpty) is used exclusively for the raw terminal view.

## Monorepo layout (npm workspaces)

```
shared/   @remotty/shared  — TypeScript types + protocol contract (builds to dist/)
server/   @remotty/server  — Node 20+ ESM, Express 4 + ws. Owns sessions, PTY, OpenCode bridge.
web/      @remotty/web     — Vite + React + TS + Tailwind v4. Mobile-first PWA.
docs/     this file
data/     runtime state (gitignored): sessions.json, chat event logs (JSONL)
```

Everything is ESM (`"type": "module"`). `shared` builds first (tsc → dist); server and web import
`@remotty/shared`. Production: `server` serves `web/dist` statically with SPA fallback. Dev: Vite
dev server proxies `/api` (HTTP + WS) to the server.

- Server port: `7710` (env `PORT`). Bind host: env `HOST`, default `0.0.0.0` (LAN; with
  Tailscale Serve the user switches to `127.0.0.1`).
- Data dir: env `REMOTTY_DATA_DIR`, default `<repo>/data`.

## Auth

- Env `REMOTTY_AUTH_TOKEN`. If unset → auth disabled, log a clear warning at startup.
- `POST /api/auth/login { token }` → sets cookie `remotty_auth` (HttpOnly, SameSite=Lax;
  `Secure` only when the request is https). All `/api/*` routes and WS upgrades require the
  cookie or `Authorization: Bearer <token>`. **Never accept the token via WS URL query string**
  (Tailscale serve has a reported issue stripping query params on WS upgrades).
- `GET /api/auth/me` → `200 { ok: true }` or `401` (used by the client to decide login screen).

## REST API (JSON, all under /api)

| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/health` | → `{ ok, version }` (no auth) |
| POST | `/api/auth/login` | `{ token }` → 204 + cookie, or 401 |
| GET | `/api/auth/me` | → `{ ok }` / 401 |
| GET | `/api/config` | → `ServerConfig` (platform, defaultRoots, homeDir, authRequired, detected CLIs) |
| GET | `/api/fs/browse?path=<abs>` | → `BrowseResult` (dirs only; omit `path` → roots listing). Normalize path; reject non-absolute. Mark `isGitRepo` (has `.git`). |
| GET | `/api/projects` | → `ProjectInfo[]` (recent, from store, most recent first) |
| POST | `/api/projects` | `{ path }` → `ProjectInfo` (validates dir exists; upserts into recents) |
| GET | `/api/opencode/models?cwd=<abs>` | → `OpencodeModelsResponse` (providers/models from `opencode serve`, starts it if needed) |
| GET | `/api/sessions` | → `SessionMeta[]` |
| POST | `/api/sessions` | `CreateSessionRequest` → `SessionMeta` |
| GET | `/api/sessions/:id` | → `SessionMeta` |
| DELETE | `/api/sessions/:id` | kills process if alive, removes meta + logs → 204 |
| GET | `/api/sessions/:id/events?afterSeq=N` | (chat only) → `{ events: ChatEventEnvelope[], lastSeq }` — replay from the JSONL log |

`CreateSessionRequest`:
```ts
{ kind: 'terminal', cwd: string, title?: string, command?: string }   // command optional: defaults to OS shell; can be 'claude', 'codex', ...
{ kind: 'chat', cwd: string, title?: string, agent: 'opencode' }
```

## WebSocket endpoints

One WS per session attach: `GET /api/sessions/:id/ws` (upgrade). Auth via cookie/header.
Multiple simultaneous attachments to the same session are allowed (phone + desktop).

### Chat protocol (JSON text frames) — see `@remotty/shared` for exact types

Server assigns a monotonically increasing `seq` to every event and appends it to the session's
JSONL log (`data/chat/<sessionId>.jsonl`) before sending. On attach the client sends
`{ type: 'attach', afterSeq: N }` and the server replays everything after N, then
`{ type: 'attached', lastSeq }` marker, then live events. This makes reconnects lossless
(mobile browsers kill sockets on screen lock — this is the norm, not the exception).

Client → server: `attach`, `user_message`, `permission_response`, `interrupt`, `set_model`,
`set_variant`, `clear_context`, `compact_context`, `ping` (server replies `pong`, outside the
seq stream).

Server → client: `ChatEventEnvelope = { seq, ev: ChatEvent }` where ChatEvent is one of:
`status`, `meta`, `user_message` (echo), `text_delta`, `assistant_message` (finalized blocks:
text + tool_use), `tool_result`, `permission_request`, `permission_resolved`, `result`
(cost/usage/duration), `error`, `notice`.

### Terminal protocol (binary frames, 1-byte opcode prefix — ttyd style)

| Direction | Opcode (first byte) | Payload |
|---|---|---|
| client→server | `'0'` (0x30) | UTF-8 keyboard input |
| client→server | `'1'` (0x31) | JSON `{ cols, rows }` resize |
| server→client | `'0'` (0x30) | raw PTY output bytes |
| server→client | `'2'` (0x32) | replay snapshot (sent once right after attach, before live output) |
| server→client | `'3'` (0x33) | JSON `{ exitCode }` — PTY exited |

WS-level ping/pong from the server every 25s. Flow control: when `ws.bufferedAmount` exceeds
~1 MB pause the PTY (`pty.pause()`), resume below ~256 KB.

## Server internals

### SessionManager
- In-memory map id → live handle (OpenCodeChatSession | TerminalSession) + persisted metadata in
  `data/sessions.json` (debounced atomic writes: write tmp + rename).
- Sessions survive WS disconnects. On server restart, terminal sessions are gone (mark
  `exited`), chat sessions can be resumed via the recorded `opencodeSessionId` when the user
  sends the next message.

### OpenCodeChatSession (the chat adapter)
Bridges WS clients to a single locally spawned `opencode serve` HTTP server (port
`REMOTTY_OPENCODE_PORT`, default 7720), shared by all chat sessions and shut down with the
server.

- **Lazy start**: creating the session only persists metadata. The first `user_message` boots
  `opencode serve` (if not already up), creates or reuses the OpenCode session scoped to the
  project cwd, and opens the project SSE stream.
- Event mapping (OpenCode bus → ChatEvent), reducer-compatible:
  - text streaming → `text_delta`; the part is finalized as `assistant_message` (which replaces
    the client's streaming buffer) when it completes or when a tool part follows it.
  - tool parts → `assistant_message` `[tool_use]` on first sight, `tool_result` on
    completed/error.
  - `permission.asked` → `permission_request`; replies go back via REST (once / always /
    reject). "Always allow" surfaces as an `opencode_always` suggestion with the rule patterns.
  - `session.idle` → `result` (+status `idle`); `session.error` → `error` event.
- SSE loop reconnects automatically on drop (1.5s retry) while the session is live.
- **Model selection**: `set_model` ('providerID/modelID' or null) and `set_variant` are persisted
  per session. Variants come from the selected model's OpenCode metadata and reset when the model
  changes; prompt model priority is user choice → env `REMOTTY_OPENCODE_MODEL` → OpenCode default.
- **Context ops**: `clear_context` creates a fresh OpenCode session under the hood (UI history
  stays, a `notice` marks the cut); `compact_context` calls OpenCode's summarize.

### BaseChatSession (shared adapter base)
Single emit path: assign `seq` → append to JSONL → broadcast to attached sockets. Attach replays
from the log after `afterSeq`, so adapters only implement `handleClientMsg` + their agent
protocol.

### TerminalSession
- `@lydell/node-pty` (1.2.0-beta.x — prebuilt binaries for win32-x64/arm64 + darwin-arm64/x64;
  no node-gyp). Default shell: `powershell.exe` on win32, `zsh` on darwin, else `bash`.
  If `command` given (e.g. `claude`, `codex`), spawn it through the shell so PATH/shims resolve:
  on Windows `powershell.exe -NoLogo -Command <command>`; on POSIX `<shell> -ilc <command>`.
- Keep a ring buffer (last ~2 MB) of raw output for replay on attach (opcode `'2'` sends the
  buffer contents; imperfect with partial escape sequences but acceptable).
- Default size 100×30 until first resize. Debounce resizes (250 ms trailing).
- `onExit` → broadcast opcode `'3'`, mark meta `exited` + `exitCode`.

### FS browsing safety
Only directory listing (no file reads). Absolute paths only, `path.resolve` + verify it exists
and is a directory. This is the user's own machine behind auth — full-disk browse is intended —
but never follow UNC/odd schemes, and catch EACCES/EPERM per entry (skip silently).

## Web app (mobile-first)

Stack: Vite + React 18 + TypeScript + Tailwind CSS v4 (`@tailwindcss/vite`), zustand for state,
react-router. Dark theme, thumb-reachable controls, `viewport-fit=cover` + safe-area insets,
`interactive-widget=resizes-content` in the viewport meta for keyboard handling.

Views:
1. **Login** — token input (only when 401).
2. **Home** — session list (cards: title, cwd basename, kind icon, status badge, cost if chat) +
   FAB "new session" → bottom sheet: pick kind (Chat / Terminale), pick folder (recent projects
   list + "browse" → folder picker modal navigating `/api/fs/browse`).
3. **Chat** — message thread: user bubbles, assistant markdown text (streaming), tool calls as
   collapsible cards (icon + tool name + one-line input summary; expand → pretty-printed input
   and result, monospace, result truncated with "show more"); permission requests as a sticky
   bottom sheet with Allow / Deny (+ "always allow" suggestion buttons from `opencode_always`);
   composer (auto-growing textarea, send button, Stop button while `running`); header: title,
   status dot, model/reasoning picker, kebab → compact/clear context, delete session. Cost/turns shown
   after each `result`.
4. **Terminal** — full-bleed xterm (`@xterm/xterm` 6.0.0 + `@xterm/addon-fit`; DOM renderer on
   iOS, WebGL elsewhere via feature detect), extra-keys bar: Esc, Tab, sticky-Ctrl, ↑ ↓ ← →,
   `/`, `|`, ^C, Enter. Buttons call `term.input(...)` and `preventDefault()` on `pointerdown`
   to keep the hidden textarea focused.

Connection layer: reconnect on `visibilitychange→visible`, `pageshow`, `online`, exponential
backoff + jitter, app-level ping every 25 s; chat reconnect sends `attach` with last seen `seq`;
terminal reconnect just reattaches (server replays snapshot). Acquire `navigator.wakeLock`
(feature-detected) while a chat run is `running`.

PWA: `manifest.webmanifest` (standalone, dark theme color, SVG icon) + minimal pass-through
service worker registered only `if (window.isSecureContext)` (over plain LAN HTTP, SW/install
are unavailable — fine).

## Designed for, not built (yet)

- More chat adapters behind the same `ChatHandle` seam (e.g. `codex app-server` JSON-RPC over
  stdio). Any agent CLI works today via the terminal view.
- ntfy push notifications on `permission_request` / `result` (one HTTP POST server-side).

## Known platform gotchas

- Never spawn `.cmd`/`.bat` shims on Windows (`spawn EINVAL` since the CVE-2024-27980 fix) and
  never `shell: true` with JSON-over-stdio. CLI presence is detected with `where.exe`/`which`.
- `@lydell/node-pty` breaks with `npm install --omit=optional` (platform package missing at
  require time) — never use that flag.
- Most agent TUIs (e.g. Claude Code) break below ~80 columns — the terminal view warns when
  narrower.
