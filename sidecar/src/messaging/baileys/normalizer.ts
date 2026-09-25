import {
  normalizeMessageContent,
  jidNormalizedUser,
  WAMessageStatus,
  type Contact,
  type WAMessage,
  type WAMessageUpdate,
} from "@whiskeysockets/baileys";
import type {
  ChatUpdate,
  ContactNames,
  Message,
  MessageReceipt,
  PhoneLink,
} from "../types";
/** Protobuf Longs, numbers and numeric strings; 0 and junk become undefined. */
function number(value: unknown) {
  const n =
    value && typeof value === "object" && "toNumber" in value
      ? (value as { toNumber(): number }).toNumber()
      : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
/** WhatsApp mixes seconds and milliseconds; anything before 2001 in ms was seconds. */
const millis = (value: unknown) => {
  const n = number(value);
  return n === undefined ? undefined : n < 1e12 ? n * 1000 : n;
};
/**
 * A chat from history sync, chats.upsert or chats.update. History entries may
 * carry only lastMsgTimestamp; account-sync updates carry just the pin or
 * archive flag, which only apply to chats already known.
 */
export function normalizeChat(chat: {
  id?: string | null;
  name?: string | null;
  conversationTimestamp?: unknown;
  lastMsgTimestamp?: unknown;
  lastMessageRecvTimestamp?: unknown;
  pinned?: unknown;
  archived?: boolean | null;
}): ChatUpdate | null {
  if (!chat.id || !/@(s\.whatsapp\.net|lid|g\.us)$/.test(chat.id)) return null;
  const times = [
    chat.conversationTimestamp,
    chat.lastMsgTimestamp,
    chat.lastMessageRecvTimestamp,
  ]
    .map(millis)
    .filter((t): t is number => t !== undefined);
  const update: ChatUpdate = {
    id: jidNormalizedUser(chat.id),
    type: chat.id.endsWith("@g.us") ? "group" : "direct",
  };
  if (chat.name) update.name = chat.name;
  if (times.length) update.lastMessageAt = Math.max(...times);
  if (chat.pinned !== undefined) update.pinnedAt = millis(chat.pinned) ?? null;
  if (typeof chat.archived === "boolean") update.archived = chat.archived;
  return update;
}
/**
 * Our message's fate after it left the socket: a rejection in the server's
 * ack (Baileys reports it as status ERROR), then delivery and read receipts.
 * The chat id is left out on purpose: WhatsApp may answer from the
 * recipient's LID for a message addressed to their phone number.
 */
export function normalizeReceipt({
  key,
  update,
}: WAMessageUpdate): MessageReceipt | null {
  if (!key.fromMe || !key.id) return null;
  switch (update.status) {
    case WAMessageStatus.ERROR: {
      const code = update.messageStubParameters?.[0];
      return {
        providerMessageId: key.id,
        status: "failed",
        ...(code ? { error: String(code) } : {}),
      };
    }
    case WAMessageStatus.DELIVERY_ACK:
      return { providerMessageId: key.id, status: "delivered" };
    case WAMessageStatus.READ:
    case WAMessageStatus.PLAYED:
      return { providerMessageId: key.id, status: "read" };
    default:
      return null;
  }
}
/**
 * Names from contact sync and message push names. A person can be known by a
 * phone-number id and a LID; the names are stored under both so either chat
 * id finds them.
 */
export function normalizeContacts(contacts: Partial<Contact>[]): ContactNames[] {
  const result: ContactNames[] = [];
  for (const c of contacts) {
    const name = c.name?.trim() || undefined,
      pushName = (c.notify || c.verifiedName)?.trim() || undefined;
    if (!name && !pushName) continue;
    const ids = new Set(
      [c.id, c.lid, c.phoneNumber]
        .filter((id): id is string => !!id && /@(s\.whatsapp\.net|lid)$/.test(id))
        .map((id) => jidNormalizedUser(id)),
    );
    for (const id of ids) result.push({ id, name, pushName });
  }
  return result;
}
/**
 * LID-to-phone pairs from anything that names a person both ways: contacts,
 * group participants, or a message key and its `Alt` twin.
 */
export function phoneLinks(
  people: { id?: string | null; lid?: string | null; phoneNumber?: string | null }[],
): PhoneLink[] {
  const links = new Map<string, string>();
  for (const p of people) {
    const ids = [p.id, p.lid, p.phoneNumber].filter((id): id is string => !!id);
    const lid = ids.find((id) => id.endsWith("@lid")),
      phone = ids.find((id) => id.endsWith("@s.whatsapp.net"));
    if (lid && phone) links.set(jidNormalizedUser(lid), jidNormalizedUser(phone));
  }
  return [...links].map(([lid, phone]) => ({ lid, phone }));
}
/**
 * Who sent a group message. Live messages carry it in the key; synced history
 * carries it only in the message's own `participant` field.
 */
function participant(raw: Pick<WAMessage, "key" | "participant">) {
  return raw.key.participant || raw.participant || undefined;
}
/** The LID and phone number a message reveals for its sender and chat. */
export function keyLinks(raw: Pick<WAMessage, "key" | "participant">) {
  return phoneLinks([
    { id: participant(raw), phoneNumber: raw.key.participantAlt },
    { id: raw.key.remoteJid, phoneNumber: raw.key.remoteJidAlt },
  ]);
}
/**
 * In groups WhatsApp often names a sender by LID and puts their phone number
 * in `participantAlt`. The phone number is dialable and matches names saved
 * in your phone, so it is preferred.
 */
function sender(raw: WAMessage) {
  const id = participant(raw),
    alt = raw.key.participantAlt;
  return id?.endsWith("@lid") && alt?.endsWith("@s.whatsapp.net") ? alt : id;
}
/**
 * The profile name a message carries, stored under every id its sender has.
 * Baileys reports push names for new messages only; synced history needs this.
 */
export function senderNames(raw: WAMessage): ContactNames[] {
  if (raw.key.fromMe || !raw.pushName) return [];
  const ids = [participant(raw), raw.key.participantAlt];
  if (!participant(raw))
    ids.push(raw.key.remoteJid ?? undefined, raw.key.remoteJidAlt ?? undefined);
  return normalizeContacts(
    ids
      .filter((id): id is string => !!id)
      .map((id) => ({ id, notify: raw.pushName! })),
  );
}
export function normalizeMessage(
  raw: WAMessage,
  selfId?: string,
): Message | null {
  const jid = raw.key.remoteJid,
    id = raw.key.id;
  if (
    !jid ||
    !id ||
    jid === "status@broadcast" ||
    jid.endsWith("@newsletter") ||
    jid.endsWith("@broadcast")
  )
    return null;
  const content = normalizeMessageContent(raw.message);
  if (
    !content ||
    content.protocolMessage ||
    content.reactionMessage ||
    (content.senderKeyDistributionMessage &&
      !Object.keys(content).some(
        (k) =>
          k === "conversation" ||
          (k.endsWith("Message") && k !== "senderKeyDistributionMessage"),
      ))
  )
    return null;
  let type: Message["type"] = "unknown",
    text: string | undefined;
  if (content.conversation != null || content.extendedTextMessage) {
    type = "text";
    text = content.conversation || content.extendedTextMessage?.text || "";
  } else if (content.imageMessage) {
    type = "image";
    text = content.imageMessage.caption || undefined;
  } else if (content.videoMessage) {
    type = "video";
    text = content.videoMessage.caption || undefined;
  } else if (content.audioMessage) type = "audio";
  else if (content.documentMessage) {
    type = "document";
    text = content.documentMessage.fileName || undefined;
  }
  const chatId = jidNormalizedUser(jid);
  const timestamp = Number(raw.messageTimestamp || 0) * 1000;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return {
    id: `whatsapp:${chatId}:${id}`,
    provider: "whatsapp",
    providerMessageId: id,
    chatId,
    senderId: jidNormalizedUser(
      raw.key.fromMe && selfId ? selfId : sender(raw) || jid,
    ),
    direction: raw.key.fromMe ? "outgoing" : "incoming",
    type,
    text,
    timestamp,
  };
}
