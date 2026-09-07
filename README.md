# Wagate

A local-first WhatsApp desktop gateway: Tauri 2, React, TypeScript, a compiled Bun sidecar, Baileys, SQLite, and OpenRouter Copilot. This implementation targets the supplied plan’s **v0.1 MVP**. Autopilot, webhooks, tunneling, MCP, multiple accounts, and media processing remain later milestones.

## Screenshots

| | |
| --- | --- |
| ![Inbox](docs/screenshots/inbox.png) | ![WhatsApp connection](docs/screenshots/whatsapp-connection.png) |
| **Inbox** — conversations synced to local SQLite, with app, sidecar, database, and AI status always in view. | **WhatsApp connection** — link once by QR from your phone's Linked Devices screen; the encrypted session restores on the next launch. |
| ![AI Copilot](docs/screenshots/ai-copilot.png) | ![API access](docs/screenshots/api-access.png) |
| **AI Copilot** — bring your own OpenRouter key. Copilot only drafts; nothing is sent without your approval. | **API access** — scoped, revocable keys for a loopback-only REST API at `127.0.0.1:8787`. |

## Download

Prebuilt macOS (Apple Silicon) bundles are on the [latest release](https://github.com/cyberfly/wagate/releases/latest). The build is unsigned, so on first launch right-click the app and choose **Open**, or clear the quarantine attribute:

```sh
xattr -dr com.apple.quarantine /Applications/Wagate.app
```

## Run on macOS

Prerequisites: Bun 1.3.14+, Rust, Xcode Command Line Tools, and several GB of free disk space for native compilation.

```sh
bun install --frozen-lockfile
bun run desktop:dev
```

The desktop starts/stops its sidecar automatically. Open **WhatsApp → Connect WhatsApp**, then scan the QR using your phone’s Linked Devices screen. After connecting, the encrypted session restores on launch. **Disconnect** pauses reconnection while retaining credentials; **Reset session** removes the session and requires another QR.

The API binds only to `127.0.0.1:8787`. Configure another port with:

```sh
WAGATE_PORT=8877 bun run desktop:dev
```

If the port is occupied, the sidecar exits and the UI reports failure. Wagate never silently attaches to another process.

### Browser UI preview

```sh
bun run preview:ui
```

Open `http://127.0.0.1:1420`. This explicitly labeled preview uses fictional, in-memory data and makes no WhatsApp or AI requests. Preview fixtures are excluded from production. `bun run dev` alone starts the frontend for Tauri and requires the native request bridge.

## Build and checks

```sh
bun run check
bun test sidecar/test
bun run build
bun run sidecar:build
bun scripts/smoke-sidecar.ts
bun run desktop:build
```

Optional live QR check, without pairing an account or sending messages:

```sh
bun scripts/smoke-pairing.ts
```

The native build hook compiles frontend and sidecar. The macOS artifact is `src-tauri/target/release/bundle/macos/Wagate.app`. Bun and dependencies are embedded; end users need no Node/Bun installation. Apple signing/notarization credentials are not included. For a debug app bundle, use `bun tauri build --debug --bundles app`.

Sidecar target mapping includes macOS arm64/x64, Windows x64, and Linux arm64/x64. Build natively on the target OS with its Tauri prerequisites. Windows installers require overriding the macOS bundle target, e.g. `--bundles nsis`; Windows packaging and credential storage are unverified.

See [implementation status](docs/implementation-status.md) and [manual acceptance](docs/acceptance.md). Automated tests use a fake messaging provider and incur no AI charges.

## REST API

Create a scoped key in **API access**, and save its one-time value. Only a SHA-256 hash is stored. Revocation takes effect immediately. Tauri uses a separate random credential per launch; the browser UI never receives it.

| Endpoint                                           | Permission                       |
| -------------------------------------------------- | -------------------------------- |
| `GET /health`                                      | None; minimal operational status |
| `GET /v1/status`                                   | Any valid key                    |
| `GET /v1/chats`                                    | `chats.read`                     |
| `GET /v1/chats/:chatId/messages?limit=50&cursor=…` | `messages.read`                  |
| `POST /v1/messages/send`                           | `messages.send`                  |
| `GET /v1/events`                                   | `messages.read` and `chats.read` |

Data endpoints require `Authorization: Bearer local_…`. Browser-origin requests are rejected. `/internal/*` is desktop-only: external keys cannot manage keys, pair WhatsApp, configure AI, or read credentials.

```sh
curl http://127.0.0.1:8787/v1/messages/send \
  -H "Authorization: Bearer $WAGATE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"to":"60123456789","text":"Hello"}'
```

Provide either `to` (international number, optional `+`) or `chatId` (WhatsApp JID), plus 1–10,000 characters of text. The response contains `success`, `messageId`, and the normalized message. Success means provider acceptance, not recipient delivery/read confirmation. Do not automatically retry timed-out sends; check delivery first to avoid duplicates.

History pages are chronological; `nextCursor` retrieves older messages, with limits of 1–100. The UI polls every two seconds and shows the latest 50 messages per chat. The list shows up to 1,000 recent chats. SSE is not durable: re-fetch history after reconnecting. Keep the desktop app open for integrations to work. No tunnel is enabled by the application.

## Copilot

1. Save an OpenRouter key, model ID, instructions, and context size in **AI Copilot**.
2. Set an individual conversation’s **AI mode → Copilot**. Default is **Off**.
3. New incoming text generates a draft; history sync does not trigger AI.
4. Edit, dismiss, or choose **Approve & send**.

Only selected recent chat context goes to OpenRouter: default 20 messages, configurable 1–50, truncated to 4,000 characters each. Responses are capped at 1,000 tokens. There are no tool calls, autonomous loops, or automatic sends. Switching Off during generation discards the result. Failed/interrupted draft sends become **uncertain** and cannot be blindly retried; verify on your phone first.

## Data and security

Desktop data uses Tauri’s app-data directory, normally `~/Library/Application Support/com.wagate.desktop/` on macOS:

- `wagate.sqlite`: chats, messages, settings, hashed API keys, drafts, encrypted secrets.
- `logs/app.log` and `logs/app.log.1`: structured metadata, rotated around 2 MB.

SQLite uses WAL, foreign keys, busy timeout, and a versioned transactional initial migration. Accounts, contacts, webhooks, and AI-profile tables reserve space for later milestones.

WhatsApp/Signal credentials and OpenRouter keys use AES-256-GCM encryption, including record-ID authentication. A per-data-directory master key is held in the OS credential store via `Bun.secrets` (macOS Keychain; platform equivalent elsewhere). There is no plaintext credential fallback. Locked/unavailable secure storage fails visibly within 12 seconds. Unlock the OS credential store and allow Wagate access before retrying; retries do not reset the session. A database backup alone cannot restore secrets without its original OS key.

Message contents remain plaintext locally in SQLite; full-disk encryption is separate. Logs omit message text, keys, raw provider errors, and authentication objects. Direct console logging from transitive Signal dependencies is replaced with fixed metadata to prevent accidental session disclosure.

There is no analytics or upload service. WhatsApp communicates with WhatsApp while connected. OpenRouter receives recent context only when Copilot runs. API integrations receive only the access you grant.

## Module boundaries

```text
React → Tauri HTTP bridge → authenticated loopback API
                               ↓
                    MessageService / CopilotService
                          ↓              ↓
                  MessagingProvider   AIProvider
                          ↓              ↓
                  BaileysProvider   OpenRouterProvider
                          ↓
                 Normalized models → SQLite → EventBus
```

Baileys types stay under `sidecar/src/messaging/baileys/`. Repositories own historical reads; SQLite is authoritative. AI consumes normalized messages and sends through the same message service as REST/UI. JavaScript receives no shell-execution permission.

References: [Tauri sidecars](https://v2.tauri.app/develop/sidecar/), [Baileys](https://github.com/WhiskeySockets/Baileys), [OpenRouter API](https://openrouter.ai/docs/api_reference/overview). Baileys is pinned to `7.0.0-rc14`; verify protocol compatibility when upgrading.