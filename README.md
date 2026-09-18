# Wagate

A local-first WhatsApp desktop gateway: Tauri 2, React, TypeScript, a compiled Bun sidecar, Baileys, SQLite, and OpenRouter Copilot. This implementation targets the supplied plan’s **v0.1 MVP**, plus optional Cloudflare Tunnel publishing, CSV broadcasts, and scheduled AI group posts. Automatic chat replies, webhooks, MCP, multiple accounts, and media processing remain later milestones.

## Screenshots

|                                                                                                             |                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| ![Inbox](docs/screenshots/inbox.png)                                                                        | ![WhatsApp connection](docs/screenshots/whatsapp-connection.png)                                                                      |
| **Inbox** — compact, full-height conversations synced to local SQLite, with unlimited local pins.           | **WhatsApp connection** — link once by QR from your phone's Linked Devices screen; the encrypted session restores on the next launch. |
| ![AI Copilot](docs/screenshots/ai-copilot.png)                                                              | ![API access](docs/screenshots/api-access.png)                                                                                        |
| **AI Copilot** — bring your own OpenRouter key. Copilot only drafts; nothing is sent without your approval. | **API access** — scoped, revocable keys for a loopback-only REST API at `127.0.0.1:8787`.                                             |

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

History pages are chronological; `nextCursor` retrieves older messages, with limits of 1–100. The UI polls every two seconds and shows the latest 50 messages per chat. The chat list has no count cap. A chat's `name`, in the UI and `GET /v1/chats`, comes from WhatsApp only, in this order: the name saved in your phone's contacts, WhatsApp's own chat name (such as a group subject), then the name the person set on their WhatsApp profile. Without any of these it is the chat ID. Saved names arrive through contact sync, and profile names with each incoming message.

The inbox fills the window with a compact navigation rail, searchable chat list, and conversation pane. Filter by **All**, **Pinned**, **Groups**, or **Archived**. Pin or unpin from a chat row or the conversation header; there is no pin count limit. Pins are saved in Wagate's local database, survive restarts, and override subsequent WhatsApp pin sync without changing pins on your phone. Until you make a local choice, a chat follows its synced WhatsApp pin state. Pinned chats appear first, most recently pinned first, followed by last activity. Enter sends a message; Shift + Enter adds a line. Unsent text stays with its chat when you switch conversations, and incoming messages preserve your scroll position when reading older messages. Narrow windows show one pane at a time with a back button.

WhatsApp's account sync mentions every chat you ever archived, muted, pinned or read, often with no activity time; those updates change chats Wagate already knows but never add one, and chats with no known activity stay out of the list until a message arrives. Account state synced before Wagate stored it (saved contact names, pins and archives) is fetched once, about 10 seconds after connecting. SSE is not durable: re-fetch history after reconnecting. Keep the desktop app open for integrations to work. No tunnel is enabled unless you start one in **API access**.

## Public access (Cloudflare Tunnel)

The gateway is loopback-only until you ask otherwise. **API access → Go public** starts a [Cloudflare quick tunnel](https://developers.cloudflare.com/tunnel/setup/#quick-tunnels-development) and shows an `https://….trycloudflare.com` address you can call from anywhere. **Stop public access** closes it; so does quitting Wagate.

The tunnel does not point at `127.0.0.1:8787`. It gets a separate loopback listener carrying the public routes only, so `/internal/*` is not mounted on it at all and the desktop token is rejected there. Public `/health` returns `{"status":"ok"}` and nothing about your account. Failed key guesses on that listener are throttled to 20 per minute; valid keys are never throttled.

At least one active API key is required before the tunnel starts — the address is otherwise useless. Anyone holding a key can read your chats and send messages from your number over that address, so publish only keys you can revoke, and revoke them when you are done.

`cloudflared` runs the tunnel. Wagate uses, in order: `WAGATE_CLOUDFLARED` if set, its own copy in the app data directory, then a `cloudflared` on your `PATH`. If none is found, the panel offers a one-time download of the pinned release (`2026.8.3`, ~20 MB) from Cloudflare's official GitHub releases over HTTPS into a `0700` directory; there is no published checksum to verify beyond that transport. `brew install cloudflared` (or your package manager) works equally well and is picked up without a restart.

Quick-tunnel caveats, all from Cloudflare: the address changes on every start, `trycloudflare.com` buffers `text/event-stream` so `GET /v1/events` will not stream through it (poll the other endpoints instead), concurrency is capped at 200 requests, and Cloudflare positions it as a debug aid rather than a production endpoint. For a stable hostname and Cloudflare Access policies, run a named tunnel yourself against `127.0.0.1:8787`.

## Broadcast from a CSV

**Broadcast** sends one personalised message to every row of a CSV, from your own number, one at a time.

1. Choose a CSV. The first line names the columns; comma, semicolon, and tab separators all work, and quoted cells may span lines (as in ticketing exports). Up to 1,000 rows per broadcast.
2. Check the **Phone number column** (detected automatically for headers such as `Phone`, `Mobile`, or `WhatsApp`). Numbers may include `+`, spaces, dashes, or brackets. Local numbers starting with `0` need a **Country code**, such as `60`.
3. Write the message with placeholders: `{{First Name}}` fills from that column (case-insensitive), and `{{Website|none}}` uses `none` when the cell is empty. Click a column chip to insert it.
4. Review each person’s message in the preview and the recipients table. Rows with an invalid number, a duplicate number, or an empty message are left out automatically; untick any row to leave it out yourself. A placeholder that matches no column blocks sending.
5. **Review and send**, then confirm.

Messages go out with a random gap, 10–20 seconds by default and 5–600 seconds allowed. Sending many near-identical messages quickly is a common reason WhatsApp restricts a number, so keep the gap generous and send only to people who expect to hear from you. Only one broadcast sends at a time, and Wagate must stay open.

Progress cards show sent, pending, and uncertain counts per broadcast, with **Pause**, **Resume**, and **Cancel**. Sent messages also appear in the inbox, named only as WhatsApp knows the person; CSV names label the broadcast and its send log, never chats. Safety rules follow the rest of Wagate:

- If WhatsApp disconnects, the broadcast pauses before the next send; reconnect and **Resume**.
- If a send fails, the delivery state is unknown. That recipient is marked **uncertain** and never retried, and the broadcast pauses so you can check your phone before resuming with the rest.
- Quitting or restarting Wagate pauses a running broadcast. It never resumes by itself, and a send that was in flight becomes uncertain.

### Send log

**View log** on a broadcast card opens its send log, which updates live while sending:

- **Recipients** lists every row with its status (Sent, Uncertain, Waiting, Skipped), the time, and any failure reason. Filter by status, or click a row to see the exact message that went out, when it was attempted and accepted, and its WhatsApp message ID.
- **Timeline** records what happened, newest first: start, each send, each failure, every pause with its reason (by you, a disconnect, a failed send, or a restart), resume, cancel, and finish.

**Save CSV** writes the recipient results to your Downloads folder as `<name>-send-log-<date>-<time>.csv`, never overwriting an existing file. **Copy CSV** puts the same text on the clipboard. The file has one row per recipient: row, name, number, status, attempted and sent times, message ID, note, and message. Cells that start like a spreadsheet formula (`=`, `+`, `-`, `@`) are prefixed with `'` so that names typed into a form by other people cannot run formulas in Excel or Sheets. Broadcasts made before version 3 of the database keep their results but have no timeline.

Broadcasts are desktop-only (`/internal/broadcasts`); API keys and the Cloudflare tunnel cannot start one. Rendered messages are stored in SQLite alongside other message text.

## Group automation

1. Save your OpenRouter key and model in **AI Copilot**.
2. Open **Group automation → Select groups**. Wagate fetches your WhatsApp groups and lets you add multiple groups where you are an admin. New groups start paused.
3. Set each group's topics, language/style/audience instructions, and content source: original tips, current news with source links, or news with original practical takeaways.
4. Choose **Require my approval** or **Post automatically** separately for each group. Choose specific weekdays with up to 12 times, or an interval of 1–168 hours within a same-day posting window. Each group has its own IANA time zone; Malaysia time is the default.
5. Save and enable its schedule. **Generate preview** uses saved settings and always creates a draft, even for automatic groups. Drafts can be edited, approved for immediate posting, or dismissed. **Pause schedule** cancels future runs and discards an automatic post still being generated.

Scheduling runs locally every 15 seconds while Wagate is open. WhatsApp must be connected. Missed slots more than five minutes late are recorded as skipped and advanced to a future time, rather than sent as a backlog. Interval schedules wait at least the selected number of hours from enabling or the previous run, then move to the next allowed posting window if necessary. Weekly schedules follow local wall time, skip nonexistent DST times, and do not repeat a wall-clock slot during DST fallback. An approval group has at most one pending post; subsequent slots are skipped until it is handled.

News/mixed posts use OpenRouter's [web search server tool](https://openrouter.ai/docs/guides/features/server-tools/web-search), capped at one search and three results per generation. The response must include source citation annotations; missing citations fail the run instead of posting uncited model knowledge. Source URLs are included in the message. Search may incur additional OpenRouter credits, and the configured model/account must support the server tool. Original posts do not request web search. The AI receives the group's topics, style instructions, current date, and up to five previous automation posts to discourage repeats; it does not receive the group's conversation history or participant list.

Settings, future run times, drafts, and posting history are stored in SQLite. Admin status is checked when saving, generating, and before sending. Failed scheduled generation or loss of admin access pauses the group. A send that throws or is interrupted becomes **uncertain**, pauses the group, and is never automatically retried. Check the group on your phone before resuming. Later WhatsApp delivery/read receipts update posting history; a rejection pauses scheduling. All configuration and approval routes are desktop-only and are absent from the public tunnel API.

The UI preview supplies five fictional admin groups and simulates configuration, previews, approval, and pause/resume without real AI, search, or WhatsApp requests. Preview configuration resets on a browser reload and its scheduler does not post autonomously.

## Copilot

1. Save an OpenRouter key, model ID, instructions, and context size in **AI Copilot**.
2. Set an individual conversation’s **AI mode → Copilot**. Default is **Off**.
3. New incoming text generates a draft; history sync does not trigger AI.
4. Edit, dismiss, or choose **Approve & send**.

### Request guard

**Keep Copilot to chat replies** is on by default. Before any request reaches OpenRouter, the incoming message is screened locally, and a message is skipped when it asks for programming help, asks for essays, homework, or other long-form writing, tries to override or expose Copilot’s instructions, or exceeds 2,000 characters. Skipped messages produce no draft and no API spend; the reason appears in the app’s alerts, and you reply yourself. The guard also prepends fixed scope instructions the conversation cannot override, and discards a generated reply that comes back as code.

Screening is pattern-based, so it is deliberately conservative: ordinary requests such as “send me the OTP code” pass. Clearing the checkbox in **AI Copilot** removes all three layers and lets Copilot answer anything.

Only selected recent chat context goes to OpenRouter for chat replies: default 20 messages, configurable 1–50, truncated to 4,000 characters each. Responses are capped at 1,000 tokens. Copilot replies have no tool calls or automatic sends. Group automation is separate and uses its own topic instructions and posting mode. Switching Off during reply generation discards the result. Failed/interrupted draft sends become **uncertain** and cannot be blindly retried; verify on your phone first.

## Data and security

Desktop data uses Tauri’s app-data directory, normally `~/Library/Application Support/com.wagate.desktop/` on macOS:

- `wagate.sqlite`: chats, messages, contact names, settings, hashed API keys, drafts, broadcasts, encrypted secrets.
- `logs/app.log` and `logs/app.log.1`: structured metadata, rotated around 2 MB.

SQLite uses WAL, foreign keys, busy timeout, and versioned transactional migrations; version 2 adds the broadcast tables, version 3 the send log, version 4 contact names, version 5 delivery receipts, version 6 chat pin and archive state (removing the CSV names version 4 had copied into contacts), version 7 unlimited local inbox pin overrides, and version 8 group automation settings and posting history to existing databases. Accounts, webhooks, and AI-profile tables reserve space for later milestones.

WhatsApp/Signal credentials and OpenRouter keys use AES-256-GCM encryption, including record-ID authentication. A per-data-directory master key is held in the OS credential store via `Bun.secrets` (macOS Keychain; platform equivalent elsewhere). There is no plaintext credential fallback. Locked/unavailable secure storage fails visibly within 12 seconds. Unlock the OS credential store and allow Wagate access before retrying; retries do not reset the session. A database backup alone cannot restore secrets without its original OS key.

Message contents remain plaintext locally in SQLite; full-disk encryption is separate. Logs omit message text, keys, raw provider errors, and authentication objects. Direct console logging from transitive Signal dependencies is replaced with fixed metadata to prevent accidental session disclosure.

There is no analytics or upload service. WhatsApp communicates with WhatsApp while connected. OpenRouter receives recent chat context when Copilot runs, or group topic/style instructions and previous automation posts when group automation runs. News automation also uses OpenRouter's web search service. API integrations receive only the access you grant.

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
