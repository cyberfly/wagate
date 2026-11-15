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

- [ ] After upgrading and connecting, chats with people saved in your phone show their saved names, and pinned and archived chats match WhatsApp within a minute; `logs/app.log` records `whatsapp.account_state.resynced`.
- [ ] The inbox order matches WhatsApp's chat list: pinned chats first, then most recent activity; archived chats only under **Archived**.
- [ ] A message from someone not in your contacts shows their WhatsApp profile name.

- [ ] Add a second profile from the sidebar, scan its QR with a second phone, and confirm both numbers show **Connected** at the same time.
- [ ] Messages sent to each number appear only in that profile's inbox; replies go out from the number of the open profile.
- [ ] Quit and reopen Wagate: both profiles reconnect without another QR.
- [ ] Create an API key limited to the second profile; `/v1/messages/send` without `X-Wagate-Profile` sends from the second number, and `X-Wagate-Profile: default` returns 403.
- [ ] Remove the second profile while connected: it disappears from **Linked Devices** on that phone, and its `profiles/<id>` directory is gone.

- [ ] Close the window: Wagate stays in the tray/Dock, a message from another phone raises a notification, and the Dock badge shows the unread chat count.
- [ ] A chat muted on the phone raises no notification and is left out of the badge; unmuting it restores both within a minute.
- [ ] Turning off **Notify me about new messages** stops notifications; hiding the text shows only "New message".
- [ ] Open Wagate a second time: the running window comes forward and no second copy starts.
- [ ] Kill `wagate-sidecar`: the inbox recovers within a few seconds without reopening the app.
- [ ] An incoming message appears in the open chat in under a second.

- [ ] First launch shows the terms; the app opens only after ticking the box and continuing, and they are not shown again on the next launch.
- [ ] Broadcast and Add to group start on the Careful pace (30–60 s) and cannot be started until the consent box is ticked.

- [ ] Profile pictures appear in the chat list and header within a minute of scrolling to a chat, and are still there after a restart.
- [ ] Photos, videos and voice notes display in a release build (the content security policy now allows `blob:` media).
- [ ] Searching a word from an old message lists it under **Messages**; clicking it opens the chat at that message.
- [ ] Adding someone to a test group, renaming it, and leaving it each show a centred line with the right names.
- [ ] With a chat open, the other phone sees "online" and "typing…"; typing on the other phone shows "typing…" in the header. Switching to another app takes Wagate offline within seconds.
- [ ] With **Show when I am online and typing** off, the other phone never sees Wagate online.

- [ ] Mute (8 hours), archive, mark unread and block from a chat's menu each show on the phone within seconds; undoing each on the phone shows in Wagate.
- [ ] Deleting a test chat removes it from Wagate and from the phone; a new message from that person brings back a fresh chat.
- [ ] A contact blocked on the phone shows the blocked notice in Wagate, and cannot be messaged until unblocked.
- [ ] In a test group, typing `@` lists members; a sent mention shows as a tappable name on the other phone and notifies that person.
- [ ] Typing a link shows a preview card above the message box; the sent message shows the same card on the other phone. With link previews turned off, no card appears.
- [ ] A recorded voice message plays on both an Android phone and an iPhone, shows as a voice message (not a file), and shows its length. First use asks for microphone access on macOS and on Windows.

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
