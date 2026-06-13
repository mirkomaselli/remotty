# remotty

<table align="center">
  <tr>
    <td align="center"><img src="docs/screenshots/home.png" width="240" alt="Home — list of chat and terminal sessions" /><br /><sub><b>Home</b> · session list</sub></td>
    <td align="center"><img src="docs/screenshots/new-session.png" width="240" alt="New session — choose Chat (OpenCode) or Terminal" /><br /><sub><b>New session</b> · Chat (OpenCode) or Terminal</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/chat.png" width="240" alt="Chat — tool-call cards and an Allow / Deny permission prompt" /><br /><sub><b>Chat</b> · tool cards + permission prompt</sub></td>
    <td align="center"><img src="docs/screenshots/terminal.png" width="240" alt="Terminal — xterm with the extra-keys bar" /><br /><sub><b>Terminal</b> · xterm + extra-keys bar</sub></td>
  </tr>
</table>

Code from your phone. **remotty** is a self-hosted web app that runs on your dev machine and
wraps terminal coding agents in a mobile-first chat UI — powered by [OpenCode](https://opencode.ai)
— plus a folder browser and a real terminal (xterm over ConPTY/forkpty) as a fallback for
anything else (including other agent CLIs like `claude` or `codex`).

No API keys: bring your own agent login. OpenCode works out of the box with its free provider,
or with your existing subscriptions (`opencode auth login`).

- **Chat** — streaming responses, tool calls as collapsible cards, permission prompts as
  Allow / Deny / Always-allow sheets, model picker, context compact/clear.
- **Terminal** — full xterm with extra-keys bar (Esc, Tab, sticky Ctrl, arrows), replay buffer
  on reconnect. Run any TUI, including other coding agents.
- **Mobile-first PWA** — installable on the home screen (over HTTPS), wake lock while the agent
  runs, lossless reconnect after screen lock.
- **Self-hosted** — a single Node server on your machine; your code never leaves it.

Monorepo (npm workspaces): `shared/` (protocol contract), `server/` (Express + ws + OpenCode
adapter), `web/` (Vite + React + Tailwind, PWA).

## Requirements

- Node.js >= 20 (tested on Node 24, Windows 11 and macOS Apple Silicon)
- [OpenCode](https://opencode.ai) CLI for the chat: `npm install -g opencode-ai`
  (the terminal works without it)

## Install

```bash
npm install
```

> **Never use `npm install --omit=optional`**: it breaks the platform binaries of
> `@lydell/node-pty` (missing at require time). If you did: delete `node_modules`
> and reinstall without the flag.

## Build & run

```bash
npm run build
npm start
```

The production server serves the compiled web app (`web/dist`) by itself.

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `7710` | HTTP/WS port |
| `HOST` | `0.0.0.0` | Bind address (use `127.0.0.1` behind Tailscale Serve) |
| `REMOTTY_AUTH_TOKEN` | _(empty = auth disabled!)_ | Token required at login, via cookie or `Authorization: Bearer` |
| `REMOTTY_DATA_DIR` | `<repo>/data` | Runtime state: `sessions.json`, chat JSONL logs |
| `REMOTTY_OPENCODE_PORT` | `7720` | Local port of the `opencode serve` spawned by the server |
| `REMOTTY_OPENCODE_MODEL` | _(OpenCode default)_ | Model for chats, `provider/model` format (e.g. `anthropic/claude-sonnet-4-6`) |

## Use it from your phone (LAN)

1. **Set `REMOTTY_AUTH_TOKEN`** — without it, anyone on your network can run commands on your
   machine:

   ```powershell
   # PowerShell
   $env:REMOTTY_AUTH_TOKEN = 'a-long-random-token'; npm start
   ```

   ```bash
   # bash/zsh
   REMOTTY_AUTH_TOKEN='a-long-random-token' npm start
   ```

2. Open `http://<your-pc-ip>:7710` from the phone (reachable IPs are printed at startup) and
   enter the token on the login screen.

Over plain HTTP the browser won't offer PWA install or a service worker; the app still works.
For the full experience see Tailscale below.

### Install on iPhone

iOS does not normally show an automatic PWA installation prompt. Open remotty over **HTTPS in
Safari**, tap **Share**, then choose **Add to Home Screen** (and enable **Open as Web App** if
shown). Opening the site inside another app's embedded browser may hide this option.

Push notifications require iOS/iPadOS 16.4 or later, HTTPS, and the Home Screen installation.
Open Remotty from its installed icon, then tap the bell on the Home screen and allow notifications.
VAPID keys and browser subscriptions are generated automatically and stored in `data/push.json`.

### Android app

The Android wrapper uses Capacitor and keeps the existing React UI. From Remotty's Home screen
in a desktop browser, select the QR button, then scan the code from the Android app. The app
stores the server URL and uses the QR token only for the initial login.

Build or refresh the native project:

```bash
npm run android:build
```

Building the APK requires Android SDK 35 and JDK 21. On macOS the build script automatically
uses the JDK bundled with Android Studio. Set `ANDROID_HOME` or `android/local.properties` to
the installed SDK if Android Studio has not configured it.

The debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. The wrapper
supports HTTPS/Tailscale and plain LAN HTTP; HTTPS remains recommended for transport security
and browser push support. The Android wrapper hides the PWA Web Push controls because that flow
does not apply inside Capacitor; native Android notifications are not implemented yet.

## Tailscale (recommended)

With Tailscale on both PC and phone you get valid HTTPS (installable PWA, reliable wake lock and
clipboard) without opening any ports:

```bash
# bind local only, then expose via Tailscale Serve
HOST=127.0.0.1 npm start
tailscale serve --bg --https=443 --set-path=/remotty \
  http://127.0.0.1:7710/remotty
```

The app becomes reachable at `https://<machine-name>.<tailnet>.ts.net/remotty/` from any device
on your tailnet. Other local apps can use different paths on the same HTTPS hostname. Keep
`REMOTTY_AUTH_TOKEN` set anyway.

On the first run, Tailscale may print an authorization URL asking the tailnet owner to enable
**Serve**. Enable Serve only. **Do not enable Funnel**: Serve keeps Remotty private to authenticated
devices in your tailnet, while Funnel would publish it to the public Internet.

The macOS App Store version may not install `tailscale` in the shell `PATH`. In that case use:

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve \
  --bg --https=443 --set-path=/remotty \
  http://127.0.0.1:7710/remotty
```

Verify the active proxy and find the HTTPS address with:

```bash
tailscale serve status
```

After enabling Serve, remove any Remotty icon previously installed from an `http://` address.
Open the new `https://<machine-name>.<tailnet>.ts.net/remotty/` address in Safari, add it to the
Home Screen again, open that installed icon, and enable notifications from the bell.

Remotty defaults to the `/remotty` base path. To use a different path, set the same value while
building and running:

```bash
REMOTTY_BASE_PATH=/coding npm run build
REMOTTY_BASE_PATH=/coding npm start
```

## OpenCode chat

The server lazily spawns a single `opencode serve` on `127.0.0.1:7720` at the first message and
talks to it over HTTP + SSE; sessions are scoped per project folder.

- **No login needed** to start: the free `opencode` provider works immediately.
- To use **your own** models/subscriptions: run `opencode auth login` on the PC
  (e.g. Anthropic → Claude Pro/Max).
- **Model and reasoning picker in chat**: the header button lists every provider/model configured
  in OpenCode and the reasoning variants supported by the selected model (for example low, high
  or max). Both choices are persisted per session and can be changed mid-conversation. Model
  priority: in-chat choice → `REMOTTY_OPENCODE_MODEL` → OpenCode default.
- **Agent picker**: switch between OpenCode's primary agents (`build`, `plan`) and project/global
  custom primary agents. The picker shows their effective edit and shell permission levels;
  hidden system agents and subagents are not selectable.
- **Agent questions**: OpenCode question prompts are rendered as native mobile controls with
  single-choice, multiple-choice and custom text answers when requested by OpenCode, instead of
  leaving the session waiting invisibly.
- **Attachments**: add screenshots, photos, PDFs, text files and other model-supported files
  directly from the mobile composer. Up to 6 files, 20 MB each and 40 MB total per message.
  File contents are forwarded to OpenCode but are not persisted in Remotty's chat event log.
  Model input capabilities are shown in the picker, and incompatible media is blocked before send.
- **Push notifications**: enable them from the bell on the Home screen to be notified when
  OpenCode asks a question or waits for permission. Notifications contain no prompt or tool
  details and open the relevant chat directly.
- **Context controls** (chat ⋮ menu): *clear context* starts a fresh agent session under the
  hood (UI history stays), *compact context* summarizes the conversation to free context
  (like `/compact`).
- The `opencode serve` process is shut down together with the server.

## Development

```bash
npm run dev
```

Starts the server (`tsx watch`, port 7710) and the Vite dev server in parallel; Vite proxies
`/api` (HTTP + WS). End-to-end smoke test (no agent is ever started):

```bash
npm run build && node scripts/smoke.mjs
```

Deterministic OpenCode question/reply/reject smoke (uses a local mock, no model call):

```bash
npm run smoke:questions
```

OpenCode adapter e2e smoke (requires `opencode` installed; uses the free provider, zero cost):

```bash
node scripts/smoke-opencode.mjs
```

## License

[MIT](LICENSE)
