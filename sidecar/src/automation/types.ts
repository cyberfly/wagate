export type AutomationSchedule =
  | { kind: "weekly"; weekdays: number[]; times: string[] }
  | {
      kind: "interval";
      everyHours: number;
      startTime: string;
      endTime: string;
    };
export interface GroupAutomationInput {
  topics: string;
  instructions: string;
  source: "original" | "news" | "mixed";
  delivery: "automatic" | "approval";
  timeZone: string;
  schedule: AutomationSchedule;
  enabled: boolean;
}
export interface GroupAutomation extends GroupAutomationInput {
  chatId: string;
  groupName: string;
  nextRunAt: number | null;
  updatedAt: number;
  revision: number;
}
export interface AutomationPost {
  id: string;
  chatId: string;
  groupName: string;
  status:
    | "generating"
    | "pending"
    | "sending"
    | "sent"
    | "delivered"
    | "read"
    | "failed"
    | "uncertain"
    | "dismissed"
    | "skipped";
  text: string;
  error: string | null;
  scheduledFor: number | null;
  createdAt: number;
  sentAt: number | null;
  messageId: string | null;
  providerMessageId: string | null;
}
