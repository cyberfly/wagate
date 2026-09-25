import {
  jidNormalizedUser,
  type Contact,
  type GroupMetadata,
} from "@whiskeysockets/baileys";
import type { GroupAddResult, GroupInfo } from "../types";
export function groupInfo(
  group: GroupMetadata,
  user: Contact | undefined,
): GroupInfo {
  const ownIds = new Set(
    [user?.id, user?.lid, user?.phoneNumber]
      .filter((id): id is string => !!id)
      .map(jidNormalizedUser),
  );
  const self = group.participants.find((p) =>
    [p.id, p.lid, p.phoneNumber].some(
      (id) => id && ownIds.has(jidNormalizedUser(id)),
    ),
  );
  return {
    id: group.id,
    name: group.subject || group.id,
    memberCount: group.size ?? group.participants.length,
    isAdmin:
      !!self &&
      (self.admin === "admin" ||
        self.admin === "superadmin" ||
        self.isAdmin === true ||
        self.isSuperAdmin === true),
  };
}
/** Why WhatsApp refused to add someone, by the error code it returned. */
const addErrors: Record<string, string> = {
  "401": "They blocked this number",
  "404": "Not on WhatsApp",
  "408": "Left the group recently, so they cannot be added back yet",
  "500": "The group is full",
};
const user = (jid?: string) => jid?.split("@")[0].split(":")[0];
/**
 * Turns the reply to a `groupParticipantsUpdate(..., "add")` into one result
 * per requested number. WhatsApp may answer with a LID instead of the phone
 * number, so results match on `phone_number` too, then on position.
 */
export function addResults(
  phones: string[],
  replies: { status: string; jid?: string; content?: { attrs?: Record<string, string> } }[],
): GroupAddResult[] {
  const byPhone = new Map<string, (typeof replies)[number]>();
  const unmatched: (typeof replies)[number][] = [];
  for (const reply of replies) {
    const phone = [reply.jid, reply.content?.attrs?.phone_number]
      .map(user)
      .find((u) => u && phones.includes(u));
    if (phone) byPhone.set(phone, reply);
    else unmatched.push(reply);
  }
  const positional = replies.length === phones.length;
  return phones.map((phone, i) => {
    const reply =
      byPhone.get(phone) ??
      (positional && unmatched.includes(replies[i]) ? replies[i] : undefined);
    if (!reply)
      return { phone, status: "failed", error: "WhatsApp gave no result" };
    const code = reply.status;
    if (code === "200") return { phone, status: "added" };
    if (code === "409") return { phone, status: "already" };
    if (code === "403")
      return {
        phone,
        status: "invite",
        error: "Their privacy settings need an invite link",
      };
    return {
      phone,
      status: "failed",
      error: addErrors[code] ?? `WhatsApp refused (error ${code})`,
    };
  });
}
