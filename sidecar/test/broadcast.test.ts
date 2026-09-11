import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "./helpers";
import {
  readCsv,
  render,
  placeholders,
  normalizePhone,
  phoneColumn,
  nameFor,
  sendLogCsv,
  toCsv,
} from "../src/broadcast/csv";
import { openDatabase } from "../src/db/database";
import { migrations } from "../src/db/schema";
import { BroadcastRepository } from "../src/broadcast/broadcast-repository";
import type { Broadcast } from "../src/messaging/types";
// Same shape as an event-ticketing export: quoted cells span lines, some
// cells carry stray spaces, and optional columns are empty. People are fictional.
const ticketing = `"First Name","Last Name",Progress,Ticket,"Amount Paid",Date,Email,Phone,Website,Company
Aina,"Salleh ",paid,"1 x Early Bird
","RM 129.00","Sep 10 2026, 22:21",aina@example.com,+60120000001,,NA
"Ben Chong",Wei,paid,"1 x Early Bird
","RM 139.00","Sep 09 2026, 08:16",ben@example.com,+60120000002,,"Chong ""BC"" Trading"
`;
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
};
const input = (n = 3, extra: Partial<{ minDelay: number }> = {}) => ({
  name: "Launch",
  minDelay: 5,
  maxDelay: 10,
  recipients: Array.from({ length: n }, (_, i) => ({
    to: `+6012000000${i + 1}`,
    label: `Person ${i + 1}`,
    text: `Hello ${i + 1}`,
  })),
  ...extra,
});
test("CSV parsing handles quoted newlines, doubled quotes, and stray spaces", () => {
  const table = readCsv(ticketing);
  expect(table.headers).toContain("First Name");
  expect(table.rows).toHaveLength(2);
  expect(table.rows[0]).toMatchObject({
    "Last Name": "Salleh",
    Ticket: "1 x Early Bird",
    Phone: "+60120000001",
    Website: "",
  });
  expect(table.rows[1].Company).toBe('Chong "BC" Trading');
  expect(phoneColumn(table.headers)).toBe("Phone");
  expect(nameFor(table.rows[1])).toBe("Ben Chong Wei");
  // Semicolon exports (common from spreadsheet apps in some locales) and a BOM.
  expect(readCsv("\uFEFFName;Phone\r\nAli;0123456789\r\n").rows).toEqual([
    { Name: "Ali", Phone: "0123456789" },
  ]);
  // Duplicate or blank headers stay addressable.
  expect(readCsv("Name,Name,\nA,B,C").headers).toEqual([
    "Name",
    "Name (2)",
    "Column 3",
  ]);
});
test("templates fill columns case-insensitively, with fallbacks and diagnostics", () => {
  const row = readCsv(ticketing).rows[0];
  const template =
    "Hi {{ first name }}, your {{Ticket}} ticket ({{Amount Paid}}) is confirmed. {{Website|No website}} {{Company}} {{Website}} {{Nickname}}";
  expect(placeholders(template)).toEqual([
    "first name",
    "Ticket",
    "Amount Paid",
    "Website",
    "Company",
    "Nickname",
  ]);
  const result = render(template, row);
  expect(result.text).toBe(
    "Hi Aina, your 1 x Early Bird ticket (RM 129.00) is confirmed. No website NA",
  );
  expect(result.unknown).toEqual(["Nickname"]);
  expect(result.empty).toEqual(["Website"]);
});
test("phone numbers normalise to international digits", () => {
  expect(normalizePhone("+60 12-345 6789")).toEqual({ phone: "60123456789" });
  expect(normalizePhone("0060123456789")).toEqual({ phone: "60123456789" });
  expect(normalizePhone("(012) 345-6789", "60")).toEqual({
    phone: "60123456789",
  });
  expect(normalizePhone("0123456789")).toEqual({
    error: "Local number: set a country code",
  });
  expect(normalizePhone("6.01E+10")).toEqual({ error: "Invalid number" });
  expect(normalizePhone("")).toEqual({ error: "No number" });
});
test("older databases upgrade to the current version without losing data", () => {
  const dir = mkdtempSync(join(tmpdir(), "wagate-migrate-"));
  const upgrade = (name: string, steps: string[], seed: string) => {
    const path = join(dir, name);
    const old = new Database(path, { create: true });
    for (const step of steps) old.exec(step);
    old.exec(seed);
    old.close();
    const db = openDatabase(path);
    expect(
      (db.query("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    ).toBe(migrations.length);
    return db;
  };
  const v1 = upgrade(
    "v1.sqlite",
    [migrations[0]],
    "INSERT INTO settings(key,value) VALUES('whatsapp.autoConnect','true')",
  );
  expect(v1.query("SELECT value FROM settings").get()).toEqual({
    value: "true",
  });
  expect(new BroadcastRepository(v1).list()).toEqual([]);
  v1.close();
  // A broadcast from before the send log keeps its results, with no timeline.
  const v2 = upgrade(
    "v2.sqlite",
    migrations.slice(0, 2),
    `INSERT INTO broadcasts VALUES('b','Old','completed',5,10,NULL,1,1);
     INSERT INTO broadcast_recipients(broadcast_id,position,chat_id,label,text,status,sent_at)
       VALUES('b',1,'60120000001@s.whatsapp.net','Aina','Hi','sent',1)`,
  );
  const repository = new BroadcastRepository(v2);
  expect(repository.get("b")).toMatchObject({ total: 1, sent: 1 });
  expect(repository.recipients("b")[0]).toMatchObject({
    status: "sent",
    attemptedAt: null,
  });
  expect(repository.events("b")).toEqual([]);
  v2.close();
  rmSync(dir, { recursive: true });
});
test("a broadcast sends each message once, in order, through the message service", async () => {
  const s = setup();
  const created = s.broadcasts.create(input());
  expect(created).toMatchObject({ status: "running", total: 3, pending: 3 });
  await until(() => s.broadcasts.get(created.id).broadcast.status === "completed");
  expect(s.provider.sent.map((m) => [m.chatId, m.text])).toEqual([
    ["60120000001@s.whatsapp.net", "Hello 1"],
    ["60120000002@s.whatsapp.net", "Hello 2"],
    ["60120000003@s.whatsapp.net", "Hello 3"],
  ]);
  const { broadcast, recipients } = s.broadcasts.get(created.id);
  expect(broadcast).toMatchObject({ sent: 3, pending: 0, uncertain: 0 });
  expect(recipients.every((r) => r.status === "sent" && r.messageId)).toBe(true);
  // Sent messages land in the inbox like any other outgoing message.
  expect(s.messages.page("60120000002@s.whatsapp.net").messages).toHaveLength(1);
  s.close();
});
test("pause stops sending; resume carries on; cancel skips the rest", async () => {
  const s = setup();
  const b = s.broadcasts.create(input(4));
  s.broadcasts.pause(b.id);
  await Bun.sleep(20);
  expect(s.provider.sent).toHaveLength(0);
  expect(() => s.broadcasts.pause(b.id)).toThrow("Broadcast is not sending");
  // Hold the first send open so the broadcast can be cancelled mid-flight.
  let release = () => {};
  const send = s.provider.sendText.bind(s.provider);
  s.provider.sendText = (chatId, text) =>
    new Promise((resolve) => {
      release = () => resolve(send(chatId, text));
    });
  s.broadcasts.resume(b.id);
  await until(() => s.broadcasts.get(b.id).recipients[0].status === "sending");
  s.broadcasts.cancel(b.id);
  release();
  await until(() => s.broadcasts.get(b.id).recipients[0].status === "sent");
  await Bun.sleep(20);
  expect(s.provider.sent).toHaveLength(1);
  expect(s.broadcasts.get(b.id).broadcast).toMatchObject({
    status: "cancelled",
    sent: 1,
    cancelled: 3,
  });
  expect(() => s.broadcasts.resume(b.id)).toThrow("Broadcast is not paused");
  s.broadcasts.remove(b.id);
  expect(s.broadcasts.list()).toEqual([]);
  s.close();
});
test("a failed send is marked uncertain, pauses the broadcast, and is never retried", async () => {
  const s = setup();
  const errors: unknown[] = [];
  s.events.subscribe((e) => e.type === "broadcast.error" && errors.push(e.data));
  const send = s.provider.sendText.bind(s.provider);
  let calls = 0;
  s.provider.sendText = async (chatId, text) => {
    if (++calls === 2) throw new Error("socket closed");
    return send(chatId, text);
  };
  const b = s.broadcasts.create(input(3));
  await until(() => s.broadcasts.get(b.id).broadcast.status === "paused");
  const paused = s.broadcasts.get(b.id);
  expect(paused.recipients.map((r) => r.status)).toEqual([
    "sent",
    "uncertain",
    "pending",
  ]);
  expect(paused.broadcast.error).toContain("Sending to Person 2 failed");
  expect(errors).toEqual([
    {
      id: b.id,
      error: expect.stringMatching(/^Broadcast paused: Sending to Person 2 failed/),
    },
  ]);
  s.broadcasts.resume(b.id);
  await until(() => s.broadcasts.get(b.id).broadcast.status === "completed");
  expect(calls).toBe(3);
  expect(s.broadcasts.get(b.id).broadcast).toMatchObject({
    sent: 2,
    uncertain: 1,
  });
  s.close();
});
test("losing WhatsApp pauses before the next send, without marking anyone uncertain", async () => {
  const s = setup();
  const send = s.provider.sendText.bind(s.provider);
  s.provider.sendText = async (chatId, text) => {
    const message = await send(chatId, text);
    s.provider.state = { status: "reconnecting" };
    return message;
  };
  const b = s.broadcasts.create(input(2));
  await until(() => s.broadcasts.get(b.id).broadcast.status === "paused");
  expect(s.broadcasts.get(b.id).broadcast).toMatchObject({
    sent: 1,
    pending: 1,
    uncertain: 0,
  });
  expect(() => s.broadcasts.resume(b.id)).toThrow("WhatsApp is disconnected");
  s.provider.state = { status: "connected" };
  s.broadcasts.resume(b.id);
  await until(() => s.broadcasts.get(b.id).broadcast.status === "completed");
  s.close();
});
test("a restart pauses running broadcasts and flags in-flight sends as uncertain", () => {
  const s = setup();
  const b = s.broadcasts.create(input(2));
  s.broadcasts.close();
  s.db
    .query("UPDATE broadcast_recipients SET status='sending' WHERE position=1")
    .run();
  const repository = new BroadcastRepository(s.db);
  expect(repository.get(b.id)).toMatchObject({
    status: "paused",
    uncertain: 1,
    pending: 1,
  } satisfies Partial<Broadcast>);
  expect(
    repository.events(b.id).map((e) => [e.type, e.position, e.detail]),
  ).toEqual([
    ["created", null, "2 recipients"],
    ["uncertain", 1, "Wagate stopped while sending"],
    ["paused", null, "Wagate restarted. Resume to continue."],
  ]);
  s.close();
});
test("the send log records every outcome and state change, in order", async () => {
  const s = setup();
  const send = s.provider.sendText.bind(s.provider);
  let calls = 0;
  s.provider.sendText = async (chatId, text) => {
    if (++calls === 2) throw new Error("socket closed");
    return send(chatId, text);
  };
  const b = s.broadcasts.create(input(3));
  await until(() => s.broadcasts.get(b.id).broadcast.status === "paused");
  s.broadcasts.resume(b.id);
  await until(() => s.broadcasts.get(b.id).broadcast.status === "completed");
  const { events, recipients } = s.broadcasts.get(b.id);
  expect(events.map((e) => [e.type, e.label, e.detail])).toEqual([
    ["created", null, "3 recipients"],
    ["sent", "Person 1", null],
    [
      "uncertain",
      "Person 2",
      "Send failed. Delivery is unknown; check this chat on your phone.",
    ],
    [
      "paused",
      null,
      "Sending to Person 2 failed. Check that chat on your phone, then resume to continue with the rest.",
    ],
    ["resumed", null, null],
    ["sent", "Person 3", null],
    ["completed", null, "2 sent, 1 uncertain"],
  ]);
  expect(events[1].chatId).toBe("60120000001@s.whatsapp.net");
  expect(events.every((e, i) => !i || e.at >= events[i - 1].at)).toBe(true);
  // Each attempt is timed, including the one whose outcome is unknown.
  expect(recipients[1]).toMatchObject({ status: "uncertain", sentAt: null });
  expect(recipients[1].attemptedAt).toBeNumber();
  expect(recipients[0].sentAt! >= recipients[0].attemptedAt!).toBe(true);
  // A pause by the user carries no reason; a cancel counts what it skipped.
  const c = s.broadcasts.create(input(4));
  s.broadcasts.pause(c.id);
  s.broadcasts.cancel(c.id);
  expect(
    s.broadcasts.get(c.id).events.map((e) => [e.type, e.detail]),
  ).toEqual([
    ["created", "4 recipients"],
    ["paused", null],
    ["cancelled", "4 not sent"],
  ]);
  s.close();
});
test("CSV output quotes as needed and defuses spreadsheet formulas", () => {
  expect(
    toCsv([
      ["a", "b,c", 'say "hi"', "two\nlines"],
      ["=HYPERLINK(\"x\")", "+60123", "-1", "@me", "plain"],
    ]),
  ).toBe(
    'a,"b,c","say ""hi""","two\nlines"\r\n' +
      "\"'=HYPERLINK(\"\"x\"\")\",'+60123,'-1,'@me,plain\r\n",
  );
  const csv = sendLogCsv([
    {
      position: 1,
      chatId: "60120000001@s.whatsapp.net",
      label: "Aina",
      text: "Hi Aina, see you",
      status: "uncertain",
      messageId: null,
      error: "Send failed",
      attemptedAt: new Date(2026, 8, 11, 9, 5, 7).getTime(),
      sentAt: null,
    },
  ]);
  expect(readCsv(csv).rows).toEqual([
    {
      Row: "1",
      Name: "Aina",
      Number: "60120000001",
      Status: "Uncertain",
      Attempted: "2026-09-11 09:05:07",
      Sent: "",
      "Message ID": "",
      Note: "Send failed",
      Message: "Hi Aina, see you",
    },
  ]);
});
test("saving the send log never overwrites a file and reports failure plainly", async () => {
  const s = setup();
  const dir = mkdtempSync(join(tmpdir(), "wagate-export-"));
  const b = s.broadcasts.create({ ...input(2), name: "Launch / Sept: VIP" });
  await until(() => s.broadcasts.get(b.id).broadcast.status === "completed");
  const first = s.broadcasts.export(b.id, dir).path;
  const second = s.broadcasts.export(b.id, dir).path;
  expect(first).toMatch(/Launch-Sept-VIP-send-log-\d{4}-\d{2}-\d{2}-\d{4}\.csv$/);
  expect(second).toBe(first.replace(/\.csv$/, "-2.csv"));
  const text = readFileSync(first, "utf8");
  expect(text.startsWith("\uFEFF")).toBe(true);
  expect(readCsv(text).rows.map((r) => [r.Name, r.Status])).toEqual([
    ["Person 1", "Sent"],
    ["Person 2", "Sent"],
  ]);
  expect(statSync(first).mode & 0o777).toBe(0o600);
  expect(() => s.broadcasts.export(b.id, join(dir, "missing"))).toThrow(
    "Broadcast log could not be saved",
  );
  rmSync(dir, { recursive: true });
  s.close();
});
test("creation validates input and allows only one running broadcast", () => {
  const s = setup();
  const bad = (change: object, message: string) =>
    expect(() => s.broadcasts.create({ ...input(), ...change })).toThrow(message);
  bad({ recipients: [] }, "Broadcast needs 1–1,000 recipients");
  bad(
    { recipients: [...input(2).recipients, { to: "12", text: "x" }] },
    "Broadcast recipient 3 has an invalid phone number",
  );
  bad(
    { recipients: [...input(2).recipients, input(1).recipients[0]] },
    "Broadcast recipient 3 repeats an earlier number",
  );
  bad({ minDelay: 1 }, "Broadcast delay");
  bad({ minDelay: 30, maxDelay: 10 }, "Broadcast delay");
  s.broadcasts.create(input());
  bad({}, "Broadcast already in progress");
  s.close();
  const offline = setup();
  offline.provider.state = { status: "disconnected" };
  expect(() => offline.broadcasts.create(input())).toThrow(
    "WhatsApp is disconnected",
  );
  offline.close();
});
test("the broadcast API is desktop-only and accepts CSV-sized bodies", async () => {
  const s = setup();
  // Well over the 64 KB limit that applies to every other route.
  const big = {
    ...input(200),
    recipients: input(200).recipients.map((r) => ({
      ...r,
      text: "x".repeat(1000),
    })),
  };
  const key = s.keys.create("all", ["chats.read", "messages.read", "messages.send"]);
  expect(
    (await s.call("/internal/broadcasts", "POST", big, key.key)).status,
  ).toBe(403);
  const response = await s.call("/internal/broadcasts", "POST", big);
  expect(response.status).toBe(200);
  const { id } = (await response.json()) as Broadcast;
  const snapshot = (await (await s.call("/internal/snapshot")).json()) as {
    broadcasts: Broadcast[];
  };
  expect(snapshot.broadcasts[0]).toMatchObject({ id, total: 200 });
  const details = (await (await s.call("/internal/broadcasts/" + id)).json()) as {
    recipients: unknown[];
    events: { type: string }[];
  };
  expect(details.recipients).toHaveLength(200);
  expect(details.events[0]).toMatchObject({ type: "created" });
  expect(
    (await s.call(`/internal/broadcasts/${id}/export`, "POST", undefined, key.key))
      .status,
  ).toBe(403);
  expect((await s.call(`/internal/broadcasts/${id}/pause`, "POST")).status).toBe(200);
  const second = await s.call(`/internal/broadcasts/${id}/pause`, "POST");
  expect(second.status).toBe(400);
  expect(await second.json()).toEqual({ error: "Broadcast is not sending" });
  expect(
    (
      await s.call("/internal/broadcasts", "POST", {
        ...input(),
        recipients: [{ to: "60120000001" }],
      })
    ).status,
  ).toBe(400);
  // The tunnel's app never mounts it, even for a key with every permission.
  expect(
    (
      await s.publicApp.request("/internal/broadcasts/" + id, {
        headers: { Authorization: "Bearer " + key.key },
      })
    ).status,
  ).toBe(404);
  s.close();
});
