import type { MessagingProvider } from "../messaging/messaging-provider";
import type { GroupImport, GroupImportMember } from "../messaging/types";
import type { EventBus } from "../events/event-bus";
import { maxRecipients } from "../broadcast/csv";
/** Numbers per request. The WhatsApp app itself adds a handful at a time. */
export const batchSize = 5;
/** A random gap between requests, so a list is not added at machine speed. */
export function randomGap(job: Pick<GroupImport, "minDelay" | "maxDelay">) {
  return (job.minDelay + Math.random() * (job.maxDelay - job.minDelay)) * 1000;
}
/**
 * Adds a list of numbers to a group you administer, a few at a time.
 *
 * Imports live in memory: they are short, and WhatsApp's group is the record
 * of who joined. A request that throws may still have added its numbers, so
 * they are marked failed with a note to check the group, and the import stops.
 */
export class GroupImportService {
  private imports: GroupImport[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private provider: MessagingProvider,
    private events: EventBus,
    /** Milliseconds to wait before the next request. */
    private gap: (job: GroupImport) => number = randomGap,
  ) {}
  list() {
    return this.imports.map((i) => ({
      ...i,
      members: i.members.map((m) => ({ ...m })),
    }));
  }
  async start(
    groupId: string,
    members: { phone: string; label?: string }[],
    { minDelay, maxDelay }: { minDelay: number; maxDelay: number },
  ): Promise<GroupImport> {
    if (!/^\d{5,20}(?:-\d{5,20})?@g\.us$/.test(groupId))
      throw new Error("Invalid group");
    if (this.imports.some((i) => i.status === "running"))
      throw new Error(
        "Group import is already running. Wait for it or cancel it first.",
      );
    if (
      !Number.isInteger(minDelay) ||
      !Number.isInteger(maxDelay) ||
      minDelay < 5 ||
      maxDelay > 600 ||
      minDelay > maxDelay
    )
      throw new Error("Group import delay must be 5–600 seconds, minimum first");
    if (!members.length || members.length > maxRecipients)
      throw new Error(
        `Group import needs 1–${maxRecipients.toLocaleString("en")} numbers`,
      );
    const seen = new Set<string>();
    const list: GroupImportMember[] = members.map((m, i) => {
      const phone = String(m.phone).trim().replace(/^\+/, "");
      if (!/^[1-9]\d{6,14}$/.test(phone))
        throw new Error(`Invalid phone number in row ${i + 1}`);
      if (seen.has(phone))
        throw new Error(`Group import row ${i + 1} repeats an earlier number`);
      seen.add(phone);
      const label = String(m.label ?? "").trim().slice(0, 200);
      return { phone, label: label || phone, status: "pending", error: null };
    });
    const group = await this.provider.getGroup(groupId);
    if (!group.isAdmin)
      throw new Error(
        "Group import needs you to be an admin of this group on WhatsApp",
      );
    const now = Date.now();
    const job: GroupImport = {
      id: crypto.randomUUID(),
      groupId,
      groupName: group.name,
      status: "running",
      minDelay,
      maxDelay,
      error: null,
      createdAt: now,
      updatedAt: now,
      members: list,
    };
    this.imports.unshift(job);
    // Finished imports are only a record for this session.
    this.imports.splice(10);
    this.changed(job);
    this.schedule(job, 0);
    return job;
  }
  /**
   * Adds a few numbers at once, for adding someone from the group's chat.
   * Longer lists go through `start`, which paces its requests.
   */
  async add(groupId: string, phones: string[]) {
    if (!/^\d{5,20}(?:-\d{5,20})?@g\.us$/.test(groupId))
      throw new Error("Invalid group");
    if (!phones.length || phones.length > batchSize)
      throw new Error(
        `Group import adds 1–${batchSize} numbers at a time here. Use Add to group for a longer list.`,
      );
    const list = [...new Set(phones.map((p) => String(p).trim().replace(/^\+/, "")))];
    for (const [i, phone] of list.entries())
      if (!/^[1-9]\d{6,14}$/.test(phone))
        throw new Error(`Invalid phone number in row ${i + 1}`);
    const group = await this.provider.getGroup(groupId);
    if (!group.isAdmin)
      throw new Error(
        "Group import needs you to be an admin of this group on WhatsApp",
      );
    return { results: await this.provider.addGroupParticipants(groupId, list) };
  }
  cancel(id: string) {
    const job = this.find(id);
    if (job.status !== "running") throw new Error("Group import is not running");
    this.stop(job, "cancelled", null);
    return job;
  }
  remove(id: string) {
    const job = this.find(id);
    if (job.status === "running")
      throw new Error("Group import is running. Cancel it first.");
    this.imports = this.imports.filter((i) => i !== job);
  }
  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  private find(id: string) {
    const job = this.imports.find((i) => i.id === id);
    if (!job) throw new Error("Group import not found");
    return job;
  }
  private schedule(job: GroupImport, delay: number) {
    this.timer = setTimeout(() => void this.next(job), delay);
  }
  private async next(job: GroupImport) {
    this.timer = null;
    if (job.status !== "running") return;
    const batch = job.members
      .filter((m) => m.status === "pending")
      .slice(0, batchSize);
    if (!batch.length) {
      job.status = "completed";
      return this.changed(job);
    }
    try {
      const results = await this.provider.addGroupParticipants(
        job.groupId,
        batch.map((m) => m.phone),
      );
      if (job.status !== "running") return;
      for (const m of batch) {
        const r = results.find((r) => r.phone === m.phone);
        m.status = r?.status ?? "failed";
        m.error = r ? (r.error ?? null) : "WhatsApp gave no result";
      }
    } catch (error) {
      for (const m of batch) {
        m.status = "failed";
        m.error = "The request failed. Check the group to see if they joined.";
      }
      const reason =
        error instanceof Error && error.message === "WhatsApp is disconnected"
          ? "WhatsApp disconnected."
          : "WhatsApp did not accept the request.";
      return this.stop(job, "stopped", `${reason} The rest were not added.`);
    }
    this.changed(job);
    if (job.members.some((m) => m.status === "pending"))
      this.schedule(job, this.gap(job));
    else {
      job.status = "completed";
      this.changed(job);
    }
  }
  private stop(job: GroupImport, status: "cancelled" | "stopped", error: string | null) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    job.status = status;
    job.error = error;
    for (const m of job.members)
      if (m.status === "pending") m.status = "cancelled";
    this.changed(job);
  }
  private changed(job: GroupImport) {
    job.updatedAt = Date.now();
    this.events.publish("group_import.updated", { id: job.id });
  }
}
