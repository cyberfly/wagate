import type { AutomationSchedule, GroupAutomationInput } from "./types";

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
export function validateAutomation(value: unknown): GroupAutomationInput {
  if (!value || typeof value !== "object")
    throw new Error("Automation settings are required");
  const v = value as Record<string, unknown>;
  if (
    typeof v.topics !== "string" ||
    !v.topics.trim() ||
    v.topics.length > 4000
  )
    throw new Error("Automation topics must contain 1–4,000 characters");
  if (typeof v.instructions !== "string" || v.instructions.length > 4000)
    throw new Error(
      "Automation instructions must contain at most 4,000 characters",
    );
  if (
    typeof v.source !== "string" ||
    !["original", "news", "mixed"].includes(v.source)
  )
    throw new Error("Automation content source is invalid");
  if (
    typeof v.delivery !== "string" ||
    !["automatic", "approval"].includes(v.delivery)
  )
    throw new Error("Automation delivery mode is invalid");
  if (typeof v.enabled !== "boolean")
    throw new Error("Automation enabled must be a boolean");
  if (typeof v.timeZone !== "string" || v.timeZone.length > 100)
    throw new Error("Automation time zone is invalid");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v.timeZone }).format();
  } catch {
    throw new Error(
      "Automation time zone is invalid; use an IANA name such as Asia/Kuala_Lumpur",
    );
  }
  const s = v.schedule as Record<string, unknown> | undefined;
  let schedule: AutomationSchedule;
  if (s?.kind === "weekly") {
    if (
      !Array.isArray(s.weekdays) ||
      !s.weekdays.length ||
      s.weekdays.length > 7 ||
      s.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
    )
      throw new Error("Automation needs at least one valid weekday");
    if (
      !Array.isArray(s.times) ||
      !s.times.length ||
      s.times.length > 12 ||
      s.times.some((t) => typeof t !== "string" || !timePattern.test(t))
    )
      throw new Error("Automation needs 1–12 posting times in HH:mm format");
    schedule = {
      kind: "weekly",
      weekdays: [...new Set(s.weekdays)].sort(),
      times: [...new Set(s.times)].sort(),
    };
  } else if (s?.kind === "interval") {
    if (
      typeof s.everyHours !== "number" ||
      !Number.isInteger(s.everyHours) ||
      s.everyHours < 1 ||
      s.everyHours > 168
    )
      throw new Error("Automation interval must be 1–168 hours");
    if (
      typeof s.startTime !== "string" ||
      typeof s.endTime !== "string" ||
      !timePattern.test(s.startTime) ||
      !timePattern.test(s.endTime) ||
      s.startTime >= s.endTime
    )
      throw new Error(
        "Automation posting hours must end after they start, on the same day",
      );
    schedule = {
      kind: "interval",
      everyHours: s.everyHours,
      startTime: s.startTime,
      endTime: s.endTime,
    };
  } else throw new Error("Automation schedule is invalid");
  return {
    topics: v.topics.trim(),
    instructions: v.instructions.trim(),
    source: v.source as GroupAutomationInput["source"],
    delivery: v.delivery as GroupAutomationInput["delivery"],
    enabled: v.enabled,
    timeZone: v.timeZone,
    schedule,
  };
}

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Match UTC minutes against local wall time, including DST gaps and overlaps. */
export function nextRun(
  input: Pick<GroupAutomationInput, "schedule" | "timeZone">,
  after: number,
) {
  const s = input.schedule;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: input.timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const first =
    s.kind === "interval" ? after + s.everyHours * 3600000 : after + 1;
  const start = Math.ceil(first / 60000) * 60000;
  const days = s.kind === "weekly" ? new Set(s.weekdays) : null;
  const times = s.kind === "weekly" ? new Set(s.times) : null;
  const wallKey = (at: number) => formatter.format(at);
  const previousWallTime = s.kind === "weekly" ? wallKey(after) : null;
  for (let at = start; at <= start + 8 * 86400000; at += 60000) {
    const parts = formatter.formatToParts(at);
    const part = (type: string) => parts.find((p) => p.type === type)!.value;
    const time = `${part("hour")}:${part("minute")}`;
    if (
      s.kind === "weekly"
        ? days!.has(weekdays.indexOf(part("weekday"))) && times!.has(time)
        : time >= s.startTime && time < s.endTime
    ) {
      // A repeated local clock time during DST fallback is still one slot.
      if (s.kind === "weekly" && wallKey(at) === previousWallTime) continue;
      return at;
    }
  }
  throw new Error("Automation could not find the next scheduled time");
}
