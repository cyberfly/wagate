# Implementation status

Implemented the supplied plan’s scoped v0.1 MVP. Later milestones are deferred until live core acceptance.

| Area                          | Verification                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| Tauri shell / IPC / lifecycle | Debug and release bundles launch. Health/IPC, live QR, and paused restart verified.                   |
| Compiled Bun sidecar          | Standalone smoke passes outside project: SQLite health, authentication, graceful shutdown.      |
| SQLite / repositories         | Persistence across reopen, deduplication, stable pagination tests pass.                         |
| Baileys                       | Normalizer and encrypted auth round-trip tests pass. Live QR generation passes.                 |
| React UI                      | Native UI inspected; browser sample draft edit/approval flow passes.                            |
| REST / API keys               | Authentication, permissions, revocation, validation, sending tests pass.                        |
| OpenRouter / Copilot          | Mocked inference/errors, bounded context, Off/history exclusion, approval-only send tests pass. |
| Copilot request guard         | Incoming screening, scope instructions, code-output rejection, and guard-off bypass tests pass. |
| Cloudflare Tunnel             | Quick-tunnel spawn, hostname parse across chunk boundaries, exit/timeout failure, double-start refusal, public-app route isolation, and auth throttling tests pass. Pinned cloudflared download, extraction, and execution verified live. |
| CSV broadcast                 | CSV parsing (quoted newlines, separators, BOM), templates with fallbacks, phone normalisation, v1→v3 and v2→v3 migrations, in-order paced sending, pause/resume/cancel, disconnect pause, uncertain-on-failure without retry, restart recovery, one-at-a-time and desktop-only API tests pass. Send log: event timeline per outcome and state change, attempt times, CSV quoting and formula guarding, non-overwriting export to Downloads tests pass. UI flow and send log exercised in the browser preview. |
| Contact names / chat order    | Name precedence (saved, chat, profile, ID), contact-sync and push-name normalisation with LID/phone aliases, CSV names excluded and removed on upgrade, and chats API tests pass. Chat order: account-sync updates never add chats, pinned then activity then archived, timestamp fallbacks and pin units tests pass. On a copy of the live database the upgrade lists 64 chats in activity order and hides 427 with no known activity. The one-time saved-contacts resync ran live (4,683 saved names); the pin/archive resync (`regular_low`) is not yet verified live. |
| Multiple numbers (profiles)   | v9→v10 migration makes existing data the Main profile; per-profile isolation of chats, connection and settings; header/query profile selection with header–query conflict, unknown-profile 404, and implicit single-profile keys; per-key profile limits with 403 regardless of existence; desktop-only create/rename/remove with name validation, uniqueness and a 10-profile cap; removal unlinks a connected number (with a timeout), deletes data and narrows or revokes keys; linked-number memory and duplicate-number warning; failed profile open isolated; shared vault key with separate sessions tests pass. Compiled sidecar smoke creates a profile database under `profiles/<id>/`, serves its snapshot, and deletes it on removal. Switcher, management panel and key scoping exercised in the browser preview. Two live numbers paired at once is not yet verified. |
| Core messaging                | Photos, stickers, videos, voice notes, documents, locations, contacts and polls are recognised; attachments download on demand (expired media re-requested from the phone), are cached in SQLite, and fall back to WhatsApp's embedded preview. Replies are stored, shown with the quoted message (jump to original) and sent quoting a message in the same chat. Reactions (history and live), edits, deletes for everyone, and sent/delivered/read ticks are stored. Attachments up to 16 MB can be sent (picker, paste, drop); documents save to Downloads; links open in the system browser (web addresses only). Earlier stored messages load on scroll, and older ones can be asked of the phone. v10→v11 migration verified on a copy of the live database. Normalizer, repository, service and API tests pass; UI exercised in the browser preview. Live media download, sending and reactions are not yet verified with a paired account. |
| Native packaging              | macOS arm64 debug and optimized release app bundles built successfully.                         |

Automated checkpoint: 61 backend tests / 312 assertions, production frontend build, standalone sidecar compilation and HTTP smoke, live unauthenticated WhatsApp QR generation. No WhatsApp account was paired, no real message was sent, and no paid AI request was made. Preview data is fictional and excluded from production.

Native launch verified the loopback sidecar, SQLite connection, OS credential-store bootstrap, and a real WhatsApp pairing QR. Quitting the desktop app closes the API port. The final release build reopens successfully and preserves the disconnected/pause setting. No account was paired and no real message was sent. The disk-space issue encountered during early builds has cleared; native compilation now succeeds.

MVP account-based acceptance remains pending. Complete [acceptance.md](acceptance.md) with your WhatsApp account and OpenRouter key. Windows/macOS x64, signing/notarization, paired session restoration, real delivery, and real AI inference remain unverified.

A subsequent release connection attempt exposed a slow/unavailable credential-store operation. Recovery now has a 12-second caller timeout, shares outstanding OS requests, and permits connection retry without resetting the saved session. Regression tests cover unavailable and stalled secure storage. OpenRouter setup and authorized live send checks are still required.

## Live checkpoint — 2026-09-07

The running development gateway reports `whatsapp: connected` and `database: connected`. A read-only SQLite check found 450 chats and 2,163 stored messages (2,150 incoming and 13 outgoing). These counts prove real synchronization into local storage; they do not establish that an agent-issued send or a new live incoming-message test succeeded. No message contents or credential values were read for this check.

The active sidecar is `src-tauri/target/debug/wagate-sidecar`, owned by `target/debug/wagate`. The release application is also present, so further lifecycle testing must target the active development app rather than the separate release instance. No existing process was terminated in this check.

OpenRouter remains unconfigured. Outstanding acceptance still requires an authorized test recipient/message, live receipt confirmation, paired restart/reconnection, and real Copilot inference/approval. No test send or AI request was made.
