import {
  normalizeMessageContent,
  jidNormalizedUser,
  type WAMessage,
} from "@whiskeysockets/baileys";
import type { Message } from "../types";
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
