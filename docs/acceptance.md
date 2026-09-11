# Manual v0.1 acceptance

Use an account you control and a consenting test recipient. Automated tests are not proof of real delivery.

- [x] Build and launch the native macOS app; health shows App/Sidecar Running and Database Connected.
- [ ] Scan a WhatsApp QR from Linked Devices; verify the expected account.
- [ ] Close the app and verify the local API stops; reopen and reconnect without another QR.
- [ ] Receive a test message; verify it appears in the UI and survives restart.
- [ ] Reply from the UI and confirm receipt on the other phone.
- [ ] Create a `messages.send` API key; call `/v1/messages/send` to the test recipient and confirm receipt.
- [ ] Revoke the key; subsequent calls return 401.
- [ ] Enter an OpenRouter key and enable Copilot for one chat; leave another Off.
- [ ] Receive a new message; only the enabled chat generates a draft.
- [ ] Confirm no automatic send. Edit and approve the draft; confirm receipt without duplicates.
- [ ] Send a coding or essay request from the other phone: no draft is generated, an alert names the reason, and OpenRouter usage does not increase.
- [ ] Clear **Keep Copilot to chat replies**, resend the same request, and confirm a draft is generated again.

- [ ] Broadcast a two-row CSV to consenting test recipients; each receives only their own personalised message, once, with the configured gap.
- [ ] Pause a broadcast mid-way, confirm nothing more is sent, then resume and confirm the rest arrive.
- [ ] Disconnect WhatsApp during a broadcast; it pauses with a visible reason and resumes after reconnecting.
- [ ] The broadcast's send log shows each recipient's result and a timeline including the pause; **Save CSV** writes a file to Downloads that opens correctly in a spreadsheet.

Recovery checks:

- [ ] QR expiry refreshes or gives a visible retry state.
- [ ] Network interruption triggers bounded reconnection.
- [ ] Unlinking from the phone gives a session error and a working reset flow.
- [x] Disconnect pauses automatic reconnection across restarts.
- [ ] An occupied API port produces a visible failure.
- [ ] Invalid OpenRouter key produces an actionable error without leaking the key.
- [ ] Turning Copilot Off during generation discards the result.
- [ ] Interrupted send becomes uncertain and is not automatically retried.
- [ ] Logs contain no credentials, raw sessions, or message contents.
- [ ] OS credential-store access survives app restart/update.

Release checks: signing/notarization, macOS x64 and Windows builds, platform credential storage, installer behavior, long-running sessions, group/LID identity cases.
