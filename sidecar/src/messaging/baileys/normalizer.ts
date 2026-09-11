import {
  normalizeMessageContent,
  jidNormalizedUser,
  WAMessageStatus,
  type Contact,
  type WAMessage,
  type WAMessageUpdate,
} from "@whiskeysockets/baileys";
import type { ContactNames, Message, MessageReceipt } from "../types";
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
      raw.key.fromMe && selfId ? selfId : raw.key.participant || jid,
    ),
    direction: raw.key.fromMe ? "outgoing" : "incoming",
    type,
    text,
    timestamp,
  };
}
