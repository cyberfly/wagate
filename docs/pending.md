# Pending work

What is left before a public release, as of 2026-11-15. The work so far is on the branch `feat/production-readiness` (not pushed, not merged).

## Before anything else

- [ ] Back up `~/Library/Application Support/com.wagate.desktop/`. This branch moves the database to version 15; once it opens your data, the installed 0.2.0 app refuses to.
- [ ] Quit the installed Wagate before running `bun run desktop:dev`, or the two fight over the same WhatsApp session.

## 1. Live acceptance run (needs two real numbers)

Nothing on this branch has run against a live WhatsApp account or in a built desktop app. Work through `docs/acceptance.md`. The checks most likely to fail:

- [ ] **Voice messages play on both Android and iPhone.** Recordings are MP4/AAC, not the Ogg/Opus WhatsApp's own apps send. If they don't play, the fix is converting to Ogg/Opus before sending (`src/components/VoiceRecorder.tsx`, `sendMedia` in `sidecar/src/messaging/baileys/baileys-provider.ts`).
- [ ] **Microphone access** is asked for on macOS and on Windows on first recording.
- [ ] **Chat actions reach the phone:** mute, archive, mark unread, block, delete. Then undo each on the phone and see Wagate follow.
- [ ] **Block** works for a contact known only by phone number, and for one known only by LID.
- [ ] **Mentions** notify the mentioned person and show as a name on the other phone, in a LID-addressed group too.
- [ ] **Link previews** show on the other phone, with the picture.
- [ ] **Attachments display in a built app** (the content security policy now allows `blob:`).
- [ ] **Shell:** notifications, Dock badge, tray, hide-on-close, single instance, sidecar restart after a kill. The Windows tray code has never run.
- [ ] Profile pictures, online/typing, group event lines, search jump.

## 2. Signing and updates (needs your accounts)

- [ ] macOS: Apple Developer ID certificate, notarization in CI.
- [ ] macOS entitlements once signed: `com.apple.security.device.audio-input` for the app (voice recording), and likely `com.apple.security.cs.allow-jit` for the Bun sidecar. Without them a signed build fails silently.
- [ ] Windows: code-signing certificate.
- [ ] Auto-updater: generate an update-signing key pair, store the private key as a GitHub Actions secret on `cyberfly/wagate`, add `tauri-plugin-updater` and publish update manifests from the release workflow.

## 3. Decisions waiting on you

- [ ] Should "show when I am online and typing" default to off? It is on, matching WhatsApp Desktop.
- [ ] Keep or drop the macOS menu-bar tray icon?
- [ ] Merge `feat/production-readiness` into `main`, and bump the version (0.3.0 suggested) once acceptance passes.

## 4. Known limits, small

- [ ] The chat list shows a mention in the last message as `@number`, not the name.
- [ ] A blocked chat's header still says "Ready to send".
- [ ] Editing a message cannot add mentions.
- [ ] Search jump reaches a chat's newest 2,000 messages only; matching ignores case for unaccented Latin letters only.
- [ ] Profile pictures cover chats, not individual senders in a group, and a changed picture is picked up on the weekly re-check.
- [ ] Voice messages carry no waveform.
- [ ] Link preview lookups check where a host name leads before fetching, but do not pin that address for the fetch itself.

## 5. Later (from the audit's lower-priority list)

Not started: sending stickers, polls, contacts and locations; starred messages; disappearing messages; status updates; calls (not possible through this connection); group creation and admin tools; multi-select; drafts kept across restarts; localisation; crash reporting.
