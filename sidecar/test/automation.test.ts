import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "./helpers";
import { AutomationService } from "../src/automation/automation-service";
import { AutomationRepository } from "../src/automation/automation-repository";
import { nextRun, validateAutomation } from "../src/automation/schedule";
import { groupInfo } from "../src/messaging/baileys/groups";
import { openDatabase } from "../src/db/database";
import { migrations } from "../src/db/schema";
import { ChatRepository } from "../src/chats/chat-repository";
import type { AIProvider, AIRequest } from "../src/ai/ai-provider";
import type { GroupAutomationInput } from "../src/automation/types";

const groupId = "120363000000000001@g.us";
const secondId = "120363000000000002@g.us";
const defaults: GroupAutomationInput = {
  topics: "AI tools for business",
  instructions: "Short posts in Bahasa Melayu",
  source: "mixed",
  delivery: "approval",
  timeZone: "Asia/Kuala_Lumpur",
  schedule: {
    kind: "weekly",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    times: ["09:00", "18:00"],
  },
  enabled: true,
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
function fixture(ai?: AIProvider) {
  const s = setup();
  s.automations.close();
  s.settings.set("ai.configured", "true");
  s.provider.groups.push({
    id: secondId,
    name: "Marketing group",
    memberCount: 15,
    isAdmin: true,
  });
  let time = Date.parse("2026-09-18T00:59:00Z");
  const requests: AIRequest[] = [];
  const service = new AutomationService(
    s.automationRepository,
    ai || {
      generate: async (r) => {
        requests.push(r);
        return "A useful post with a discussion question.";
      },
    },
    s.provider,
    s.sender,
    s.chats,
    s.settings,
    s.events,
    () => time,
  );
  cleanup.push(() => {
    service.close();
    s.close();
  });
  return {
    ...s,
    service,
    requests,
    at: (at: string) => {
      time = Date.parse(at);
    },
    save: (extra: Partial<GroupAutomationInput> = {}, id = groupId) =>
      service.save(id, { ...defaults, ...extra }),
  };
}
test("weekly schedules respect local weekdays and multiple times", () => {
  expect(nextRun(defaults, Date.parse("2026-09-18T00:59:00Z"))).toBe(
    Date.parse("2026-09-18T01:00:00Z"),
  );
  expect(nextRun(defaults, Date.parse("2026-09-18T01:00:00Z"))).toBe(
    Date.parse("2026-09-18T10:00:00Z"),
  );
  expect(
    nextRun(
      {
        ...defaults,
        schedule: { kind: "weekly", weekdays: [1], times: ["09:00"] },
      },
      Date.parse("2026-09-18T02:00:00Z"),
    ),
  ).toBe(Date.parse("2026-09-21T01:00:00Z"));
  expect(
    nextRun(
      {
        ...defaults,
        timeZone: "America/New_York",
        schedule: { kind: "weekly", weekdays: [0], times: ["02:30"] },
      },
      Date.parse("2026-03-08T06:00:00Z"),
    ),
  ).toBe(Date.parse("2026-03-15T06:30:00Z"));
});
test("interval schedules stay inside posting hours and respect the minimum gap", () => {
  const input = {
    ...defaults,
    schedule: {
      kind: "interval" as const,
      everyHours: 4,
      startTime: "09:00",
      endTime: "21:00",
    },
  };
  expect(nextRun(input, Date.parse("2026-09-18T01:00:00Z"))).toBe(
    Date.parse("2026-09-18T05:00:00Z"),
  );
  expect(nextRun(input, Date.parse("2026-09-18T10:00:00Z"))).toBe(
    Date.parse("2026-09-19T01:00:00Z"),
  );
});
test("weekly wall-clock slots do not post twice during daylight-saving fallback", () => {
  expect(
    nextRun(
      {
        timeZone: "America/New_York",
        schedule: { kind: "weekly", weekdays: [0], times: ["01:30"] },
      },
      Date.parse("2026-11-01T05:30:15Z"),
    ),
  ).toBe(Date.parse("2026-11-08T06:30:00Z"));
});
test("schedule validation rejects malformed, empty and excessive schedules", () => {
  for (const patch of [
    { timeZone: "not/a-zone" },
    { enabled: "true" },
    { topics: "" },
    { source: "made-up" },
    { source: ["news"] },
    { delivery: ["automatic"] },
    { schedule: { kind: "weekly", weekdays: [], times: ["09:00"] } },
    { schedule: { kind: "weekly", weekdays: [7], times: ["09:00"] } },
    { schedule: { kind: "weekly", weekdays: [1], times: ["25:00"] } },
    {
      schedule: {
        kind: "interval",
        everyHours: 0,
        startTime: "09:00",
        endTime: "18:00",
      },
    },
    {
      schedule: {
        kind: "interval",
        everyHours: 4,
        startTime: "21:00",
        endTime: "09:00",
      },
    },
  ])
    expect(() => validateAutomation({ ...defaults, ...patch })).toThrow(
      "Automation",
    );
});
test("admin detection handles phone ids, device suffixes, LIDs and superadmins", () => {
  const group = {
    id: groupId,
    subject: "Community",
    owner: undefined,
    participants: [
      {
        id: "9999999@lid",
        phoneNumber: "60123456789@s.whatsapp.net",
        admin: "superadmin" as const,
      },
    ],
  };
  expect(groupInfo(group, { id: "60123456789:2@s.whatsapp.net" }).isAdmin).toBe(
    true,
  );
  expect(
    groupInfo(group, { id: "60123456780@s.whatsapp.net", lid: "9999999@lid" })
      .isAdmin,
  ).toBe(true);
  expect(groupInfo(group, { id: "60123456780@s.whatsapp.net" }).isAdmin).toBe(
    false,
  );
  expect(
    groupInfo(
      { ...group, participants: [{ ...group.participants[0], admin: null }] },
      { id: "60123456789@s.whatsapp.net" },
    ).isAdmin,
  ).toBe(false);
});
test("per-group topics, sources and modes are isolated; schedules send only selected groups", async () => {
  const s = fixture();
  await s.save({ delivery: "automatic", source: "original" });
  await s.save(
    { topics: "Marketing tips", delivery: "approval", source: "news" },
    secondId,
  );
  s.at("2026-09-18T01:00:00Z");
  await Promise.all([s.service.tick(), s.service.tick()]);
  expect(s.provider.sent).toHaveLength(1);
  expect(s.provider.sent[0].chatId).toBe(groupId);
  expect(s.requests.map((r) => r.webSearch)).toEqual([false, true]);
  expect(s.requests[0].messages[1].content).toContain("AI tools for business");
  expect(s.requests[1].messages[1].content).toContain("Marketing tips");
  expect(s.requests[1].messages[1].content).not.toContain(
    "AI tools for business",
  );
  expect(s.service.posts(secondId)[0].status).toBe("pending");
  await s.service.tick();
  expect(s.provider.sent).toHaveLength(1);
});
test("approval waits, accepts edits and claims a post exactly once", async () => {
  const s = fixture();
  await s.save();
  s.at("2026-09-18T01:00:00Z");
  await s.service.tick();
  expect(s.provider.sent).toHaveLength(0);
  const post = s.service.posts()[0];
  const results = await Promise.allSettled([
    s.service.approve(post.id, "Edited post"),
    s.service.approve(post.id, "Edited post"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(s.provider.sent).toHaveLength(1);
  expect(s.provider.sent[0].text).toBe("Edited post");
});
test("previews for automatic groups always wait for approval, even while paused", async () => {
  const s = fixture();
  await s.save({ delivery: "automatic", enabled: false });
  const post = await s.service.preview(groupId);
  expect(post.status).toBe("pending");
  expect(s.provider.sent).toHaveLength(0);
  s.service.dismiss(post.id);
  expect(s.service.posts()[0].status).toBe("dismissed");
});
test("waiting drafts skip new slots instead of creating an approval backlog", async () => {
  const s = fixture();
  await s.save();
  s.at("2026-09-18T01:00:00Z");
  await s.service.tick();
  s.at("2026-09-18T10:00:00Z");
  await s.service.tick();
  expect(s.requests).toHaveLength(1);
  expect(s.service.posts().filter((p) => p.status === "pending")).toHaveLength(
    1,
  );
  expect(
    s.service.posts().find((p) => p.status === "skipped")!.error,
  ).toContain("waiting");
});
test("offline and missed schedules never send a backlog; resume schedules the future", async () => {
  const s = fixture();
  await s.save({ delivery: "automatic" });
  s.provider.state.status = "disconnected";
  s.at("2026-09-18T01:00:00Z");
  await s.service.tick();
  expect(s.requests).toHaveLength(0);
  s.provider.state.status = "connected";
  s.at("2026-09-20T03:00:00Z");
  await s.service.tick();
  expect(s.provider.sent).toHaveLength(0);
  expect(s.service.posts()[0].status).toBe("skipped");
  s.service.pause(groupId);
  await s.service.resume(groupId);
  expect(s.service.list()[0].nextRunAt!).toBeGreaterThan(
    Date.parse("2026-09-20T03:00:00Z"),
  );
});
test("pausing during generation prevents automatic sending", async () => {
  let complete!: (text: string) => void;
  const s = fixture({
    generate: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  await s.save({ delivery: "automatic" });
  s.at("2026-09-18T01:00:00Z");
  const run = s.service.tick();
  while (!complete) await Bun.sleep(1);
  s.service.pause(groupId);
  complete("Generated while paused");
  await run;
  expect(s.provider.sent).toHaveLength(0);
  expect(s.service.posts()[0].status).toBe("dismissed");
});
test("lost admin access blocks posting and failed scheduled generation pauses", async () => {
  const s = fixture();
  await s.save({ delivery: "automatic" });
  s.provider.groups[0].isAdmin = false;
  s.at("2026-09-18T01:00:00Z");
  await s.service.tick();
  expect(s.provider.sent).toHaveLength(0);
  expect(s.requests).toHaveLength(0);
  expect(s.service.list()[0].enabled).toBe(false);
  expect(s.service.posts()[0].error).toContain("admin");
});
test("admin access is rechecked after AI generation and before sending", async () => {
  let complete!: (text: string) => void;
  const s = fixture({
    generate: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  await s.save({ delivery: "automatic" });
  s.at("2026-09-18T01:00:00Z");
  const run = s.service.tick();
  while (!complete) await Bun.sleep(1);
  s.provider.groups[0].isAdmin = false;
  complete("A post");
  await run;
  expect(s.provider.sent).toHaveLength(0);
  expect(s.service.list()[0].enabled).toBe(false);
});
test("uncertain delivery pauses and is never retried; receipts cannot downgrade reading", async () => {
  const s = fixture();
  await s.save({ delivery: "automatic" });
  s.provider.sendText = async () => {
    throw new Error("socket timed out");
  };
  s.at("2026-09-18T01:00:00Z");
  await s.service.tick();
  await s.service.tick();
  const post = s.service.posts()[0];
  expect(post.status).toBe("uncertain");
  expect(s.service.list()[0].enabled).toBe(false);
  await expect(s.service.approve(post.id, "Retry")).rejects.toThrow(
    "not awaiting approval",
  );
  const good = fixture();
  await good.save({ delivery: "automatic" });
  good.at("2026-09-18T01:00:00Z");
  await good.service.tick();
  const sent = good.service.posts()[0];
  good.service.receipt({
    providerMessageId: sent.providerMessageId!,
    status: "read",
  });
  good.service.receipt({
    providerMessageId: sent.providerMessageId!,
    status: "delivered",
  });
  expect(good.service.posts()[0].status).toBe("read");
  good.service.receipt({
    providerMessageId: sent.providerMessageId!,
    status: "failed",
    error: "463",
  });
  expect(good.service.posts()[0].status).toBe("failed");
  expect(good.service.list()[0].enabled).toBe(false);
});
test("settings and drafts survive reopen; interrupted sends recover as uncertain", () => {
  const dir = mkdtempSync(join(tmpdir(), "wagate-automation-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "test.sqlite");
  // Start from the prior database version to exercise the new migration.
  const old = new Database(path, { create: true });
  for (const m of migrations.slice(0, 7)) old.exec(m);
  old.close();
  let db = openDatabase(path);
  const chats = new ChatRepository(db);
  chats.upsert({
    id: groupId,
    provider: "whatsapp",
    name: "Community",
    type: "group",
    lastMessageAt: null,
  });
  let repo = new AutomationRepository(db);
  const c = repo.save(
    groupId,
    "Community",
    defaults,
    Date.parse("2026-09-18T00:59:00Z"),
  );
  const post = repo.begin(c, Date.parse("2026-09-18T01:00:00Z"), true);
  repo.finish(post.id, "pending", "Draft");
  repo.claimSend(post.id, "Draft");
  db.close();
  db = openDatabase(path);
  repo = new AutomationRepository(db);
  repo.recover(Date.now());
  expect(repo.get(groupId)!.topics).toBe(defaults.topics);
  expect(repo.get(groupId)!.enabled).toBe(false);
  expect(repo.post(post.id)!.status).toBe("uncertain");
  expect(repo.post(post.id)!.text).toBe("Draft");
  db.close();
});
test("group configuration and posting routes are desktop-only and validate inputs", async () => {
  const s = setup();
  cleanup.push(s.close);
  const path = "/internal/automations/" + encodeURIComponent(groupId);
  const key = s.keys.create("read", ["chats.read"]);
  expect(
    (await s.call("/internal/groups", "GET", undefined, key.key)).status,
  ).toBe(403);
  expect((await s.call(path, "PUT", defaults, key.key)).status).toBe(403);
  expect(
    (await s.call(path, "PUT", { ...defaults, timeZone: "bad" })).status,
  ).toBe(400);
  expect((await s.call(path, "PUT", defaults)).status).toBe(400); // No configured key.
  expect(
    (await s.call(path, "PUT", { ...defaults, enabled: false })).status,
  ).toBe(200);
  expect(
    (
      await s.call(
        "/internal/automations/60123456789%40s.whatsapp.net",
        "PUT",
        { ...defaults, enabled: false },
      )
    ).status,
  ).toBe(400);
  s.provider.groups[0].isAdmin = false;
  expect(
    (await s.call(path, "PUT", { ...defaults, enabled: false })).status,
  ).toBe(400);
});
