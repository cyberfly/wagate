import { test, expect } from "bun:test";
import { setup } from "./helpers";
import { addResults } from "../src/messaging/baileys/groups";
import type { GroupImport } from "../src/messaging/types";
const group = "120363000000000001@g.us";
const pace = { minDelay: 10, maxDelay: 20 };
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
};
const members = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    phone: `+60120000${String(i + 1).padStart(3, "0")}`,
    label: `Person ${i + 1}`,
  }));
test("WhatsApp add replies map to one result per number", () => {
  expect(
    addResults(
      ["60120000001", "60120000002", "60120000003", "60120000004", "60120000005"],
      [
        { status: "200", jid: "60120000001@s.whatsapp.net" },
        { status: "409", jid: "60120000002@s.whatsapp.net" },
        // Answered with a LID; the phone number rides along as an attribute.
        {
          status: "403",
          jid: "123456789012345@lid",
          content: { attrs: { phone_number: "60120000003@s.whatsapp.net" } },
        },
        { status: "408", jid: "60120000004@s.whatsapp.net" },
      ],
    ),
  ).toEqual([
    { phone: "60120000001", status: "added" },
    { phone: "60120000002", status: "already" },
    {
      phone: "60120000003",
      status: "invite",
      error: "Their privacy settings need an invite link",
    },
    {
      phone: "60120000004",
      status: "failed",
      error: "Left the group recently, so they cannot be added back yet",
    },
    { phone: "60120000005", status: "failed", error: "WhatsApp gave no result" },
  ]);
  // Unrecognisable ids fall back to the order they were asked in.
  expect(
    addResults(["60120000001"], [{ status: "200", jid: "999@lid" }]),
  ).toEqual([{ phone: "60120000001", status: "added" }]);
});
test("an import adds everyone in batches of five and records each outcome", async () => {
  const { call, provider } = setup();
  provider.addOutcomes.set("60120000002", "already");
  provider.addOutcomes.set("60120000003", "invite");
  const res = await call("/internal/group-imports", "POST", {
    ...pace,
    groupId: group,
    members: members(12),
  });
  expect(res.status).toBe(200);
  const job = (await res.json()) as GroupImport;
  expect(job.groupName).toBe("AI community");
  const snapshot = async () =>
    ((await (await call("/internal/snapshot")).json()) as {
      groupImports: GroupImport[];
    }).groupImports[0];
  await until(() => provider.addCalls.length === 3);
  await Bun.sleep(5);
  const latest = await snapshot();
  expect(latest.status).toBe("completed");
  expect(provider.addCalls.map((c) => c.phones.length)).toEqual([5, 5, 2]);
  expect(provider.addCalls[0]).toMatchObject({ groupId: group });
  expect(latest.members.map((m) => m.status).slice(0, 4)).toEqual([
    "added",
    "already",
    "invite",
    "added",
  ]);
  expect(latest.members[0]).toMatchObject({
    phone: "60120000001",
    label: "Person 1",
  });
});
test("an import refuses groups you do not administer, bad numbers and repeats", async () => {
  const { call, provider } = setup();
  provider.groups[0].isAdmin = false;
  let res = await call("/internal/group-imports", "POST", {
    ...pace,
    groupId: group,
    members: members(1),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("admin");
  provider.groups[0].isAdmin = true;
  res = await call("/internal/group-imports", "POST", {
    ...pace,
    groupId: group,
    members: [{ phone: "0123456789" }],
  });
  expect(((await res.json()) as { error: string }).error).toBe(
    "Invalid phone number in row 1",
  );
  res = await call("/internal/group-imports", "POST", {
    ...pace,
    groupId: group,
    members: [...members(2), members(1)[0]],
  });
  expect(((await res.json()) as { error: string }).error).toContain("row 3");
  res = await call("/internal/group-imports", "POST", {
    ...pace,
    groupId: "60123456789@s.whatsapp.net",
    members: members(1),
  });
  expect(((await res.json()) as { error: string }).error).toBe("Invalid group");
  expect(provider.addCalls).toHaveLength(0);
});
test("a failed request stops the import and skips the rest", async () => {
  const { groupImports, provider } = setup();
  provider.addError = new Error("WhatsApp is disconnected");
  const job = await groupImports.start(group, members(7), pace);
  await until(() => groupImports.list()[0].status !== "running");
  const [latest] = groupImports.list();
  expect(latest.id).toBe(job.id);
  expect(latest.status).toBe("stopped");
  expect(latest.error).toContain("WhatsApp disconnected");
  expect(latest.members.filter((m) => m.status === "failed")).toHaveLength(5);
  expect(latest.members.filter((m) => m.status === "cancelled")).toHaveLength(2);
});
test("only one import runs at a time, and a running import can be cancelled", async () => {
  const { provider, events } = setup();
  const { GroupImportService } = await import("../src/groups/group-import-service");
  // A long gap keeps the first import waiting after its first batch.
  const service = new GroupImportService(provider, events, () => 60_000);
  const job = await service.start(group, members(8), pace);
  await until(() => provider.addCalls.length === 1);
  await expect(service.start(group, members(1), pace)).rejects.toThrow(
    "already running",
  );
  service.cancel(job.id);
  const [latest] = service.list();
  expect(latest.status).toBe("cancelled");
  expect(latest.members.filter((m) => m.status === "cancelled")).toHaveLength(3);
  expect(() => service.remove(job.id)).not.toThrow();
  expect(service.list()).toHaveLength(0);
  service.close();
});
test("an import waits the chosen gap between requests and rejects bad gaps", async () => {
  const { provider, events } = setup();
  const { GroupImportService } = await import("../src/groups/group-import-service");
  const gaps: [number, number][] = [];
  const service = new GroupImportService(provider, events, (job) => {
    gaps.push([job.minDelay, job.maxDelay]);
    return 0;
  });
  await expect(
    service.start(group, members(1), { minDelay: 20, maxDelay: 10 }),
  ).rejects.toThrow("delay");
  await expect(
    service.start(group, members(1), { minDelay: 1, maxDelay: 10 }),
  ).rejects.toThrow("delay");
  const job = await service.start(group, members(11), { minDelay: 30, maxDelay: 60 });
  expect(job).toMatchObject({ minDelay: 30, maxDelay: 60 });
  await until(() => service.list()[0].status === "completed");
  expect(gaps).toEqual([
    [30, 60],
    [30, 60],
  ]);
  service.close();
});
test("a few numbers can be added straight from a group chat", async () => {
  const { call, provider } = setup();
  provider.addOutcomes.set("60120000002", "invite");
  const add = async (phones: string[], groupId = group) =>
    call(`/internal/groups/${encodeURIComponent(groupId)}/participants`, "POST", {
      phones,
    });
  const res = await add(["+60120000001", "60120000002", "60120000001"]);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    results: [
      { phone: "60120000001", status: "added" },
      { phone: "60120000002", status: "invite" },
    ],
  });
  expect(provider.addCalls).toEqual([
    { groupId: group, phones: ["60120000001", "60120000002"] },
  ]);
  expect(((await (await add(members(6).map((m) => m.phone))).json()) as { error: string }).error)
    .toContain("Use Add to group");
  expect(((await (await add(["012345"])).json()) as { error: string }).error).toBe(
    "Invalid phone number in row 1",
  );
  provider.groups[0].isAdmin = false;
  expect(((await (await add(["60120000003"])).json()) as { error: string }).error)
    .toContain("admin");
  expect(provider.addCalls).toHaveLength(1);
});
