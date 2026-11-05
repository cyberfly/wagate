import {
  normalizeMessageContent,
  jidNormalizedUser,
  proto,
  WAMessageStatus,
  WAMessageStubType,
  type Contact,
  type WAMessage,
  type WAMessageUpdate,
} from "@whiskeysockets/baileys";
import type {
  ChatUpdate,
  ContactNames,
  Message,
  MessageChange,
  MessageMedia,
  MessageReceipt,
  MessageStatus,
  PhoneLink,
  QuotedMessage,
  ReactionUpdate,
  ReceivedMessage,
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
/** Attachments WhatsApp can send, by message field. */
const mediaFields = {
  imageMessage: "image",
  videoMessage: "video",
  ptvMessage: "video",
  audioMessage: "audio",
  documentMessage: "document",
  stickerMessage: "sticker",
} as const;
type MediaField = keyof typeof mediaFields;
type Content = NonNullable<ReturnType<typeof normalizeMessageContent>>;
/** Message kinds that change another message or the chat, never a bubble of their own. */
const hidden = [
  "protocolMessage",
  "reactionMessage",
  "encReactionMessage",
  "pollUpdateMessage",
  "pinInChatMessage",
  "keepInChatMessage",
  "encEventResponseMessage",
  "albumMessage",
  "messageHistoryNotice",
  "botInvokeMessage",
] as const;
/** The kind, readable text and attachment details of one message's content. */
export function describeContent(content: Content): {
  type: Message["type"];
  text?: string;
  media?: MessageMedia;
  field?: MediaField;
} {
  if (content.conversation != null || content.extendedTextMessage)
    return {
      type: "text",
      text: content.conversation || content.extendedTextMessage?.text || "",
    };
  for (const field of Object.keys(mediaFields) as MediaField[]) {
    const m = content[field] as
      | (Record<string, unknown> & { mimetype?: string | null })
      | null
      | undefined;
    if (!m) continue;
    const media: MessageMedia = {};
    if (m.mimetype) media.mimetype = m.mimetype;
    const size = number(m.fileLength),
      width = number(m.width),
      height = number(m.height),
      seconds = number(m.seconds);
    if (size) media.size = size;
    if (width) media.width = width;
    if (height) media.height = height;
    if (seconds) media.seconds = seconds;
    if (field === "audioMessage" && m.ptt) media.ptt = true;
    let text: string | undefined;
    if (field === "documentMessage") {
      if (typeof m.fileName === "string" && m.fileName) media.fileName = m.fileName;
      text =
        (typeof m.caption === "string" && m.caption) ||
        media.fileName ||
        (typeof m.title === "string" && m.title) ||
        undefined;
    } else if (typeof m.caption === "string" && m.caption) text = m.caption;
    return { type: mediaFields[field], text, media, field };
  }
  const location = content.locationMessage || content.liveLocationMessage;
  if (location) {
    const place = content.locationMessage;
    const text =
      [place?.name, place?.address].filter(Boolean).join(" · ") ||
      content.liveLocationMessage?.caption ||
      (content.liveLocationMessage ? "Live location" : undefined);
    return {
      type: "location",
      text,
      media: {
        ...(typeof location.degreesLatitude === "number"
          ? { latitude: location.degreesLatitude }
          : {}),
        ...(typeof location.degreesLongitude === "number"
          ? { longitude: location.degreesLongitude }
          : {}),
      },
    };
  }
  if (content.contactMessage)
    return { type: "contact", text: content.contactMessage.displayName || undefined };
  if (content.contactsArrayMessage)
    return {
      type: "contact",
      text:
        content.contactsArrayMessage.contacts
          ?.map((c) => c.displayName)
          .filter(Boolean)
          .join(", ") ||
        content.contactsArrayMessage.displayName ||
        undefined,
    };
  const poll =
    content.pollCreationMessage ||
    content.pollCreationMessageV2 ||
    content.pollCreationMessageV3;
  if (poll)
    return {
      type: "poll",
      text: [
        poll.name,
        ...(poll.options ?? []).map((o) => "○ " + (o.optionName ?? "")),
      ]
        .filter(Boolean)
        .join("\n"),
    };
  const text =
    content.buttonsMessage?.contentText ||
    content.templateMessage?.hydratedTemplate?.hydratedContentText ||
    content.listMessage?.description ||
    content.interactiveMessage?.body?.text ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    content.eventMessage?.name ||
    undefined;
  return text ? { type: "text", text } : { type: "unknown" };
}
/** The reply context on whichever part of the content carries one. */
function contextInfo(content: Content) {
  for (const value of Object.values(content))
    if (value && typeof value === "object" && "contextInfo" in value) {
      const info = (value as { contextInfo?: proto.IContextInfo | null }).contextInfo;
      if (info) return info;
    }
  return undefined;
}
/** Whether a JID names our own account, by phone number or LID. */
function isSelf(jid: string | null | undefined, self: Self) {
  if (!jid) return false;
  const user = jidNormalizedUser(jid).split("@")[0]?.split(":")[0];
  return [self.id, self.lid].some(
    (s) => s && jidNormalizedUser(s).split("@")[0]?.split(":")[0] === user,
  );
}
export interface Self {
  id?: string;
  lid?: string;
}
function quoted(content: Content, self: Self): QuotedMessage | null {
  const info = contextInfo(content);
  if (!info?.stanzaId) return null;
  const inner = normalizeMessageContent(info.quotedMessage);
  const described = inner ? describeContent(inner) : { type: "unknown" as const };
  const fromMe = isSelf(info.participant, self);
  return {
    providerMessageId: info.stanzaId,
    senderId: info.participant ? jidNormalizedUser(info.participant) : null,
    fromMe,
    type: described.type,
    ...(described.text ? { text: described.text.slice(0, 500) } : {}),
  };
}
/**
 * The attachment's own message, without the reply context, re-encoded so a
 * later download (or a reply quoting it) can rebuild it.
 */
function mediaSource(content: Content, field: MediaField) {
  const media = { ...(content[field] as object) } as Record<string, unknown>;
  delete media.contextInfo;
  return proto.Message.encode(proto.Message.fromObject({ [field]: media })).finish();
}
/** The JPEG preview inside an encoded attachment message, if it has one. */
export function embeddedThumbnail(source: Uint8Array | null | undefined) {
  if (!source) return null;
  try {
    const message = proto.Message.decode(source);
    for (const field of Object.keys(mediaFields) as MediaField[]) {
      const thumb = (message[field] as { jpegThumbnail?: Uint8Array | null } | null)
        ?.jpegThumbnail;
      if (thumb?.length) return new Uint8Array(thumb);
    }
  } catch {
    /* not an attachment we can read */
  }
  return null;
}
const statuses: Partial<Record<number, MessageStatus>> = {
  [WAMessageStatus.ERROR]: "failed",
  [WAMessageStatus.PENDING]: "pending",
  [WAMessageStatus.SERVER_ACK]: "sent",
  [WAMessageStatus.DELIVERY_ACK]: "delivered",
  [WAMessageStatus.READ]: "read",
  [WAMessageStatus.PLAYED]: "read",
};
export function normalizeMessage(
  raw: WAMessage,
  selfId?: string | Self,
): ReceivedMessage | null {
  const self: Self = typeof selfId === "string" ? { id: selfId } : (selfId ?? {});
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
  const revoked = raw.messageStubType === WAMessageStubType.REVOKE;
  if (!revoked) {
    if (!content || hidden.some((k) => content[k])) return null;
    if (
      content.senderKeyDistributionMessage &&
      !Object.keys(content).some(
        (k) =>
          k === "conversation" ||
          (k.endsWith("Message") && k !== "senderKeyDistributionMessage"),
      )
    )
      return null;
  }
  const described = content && !revoked ? describeContent(content) : { type: "text" as const };
  const chatId = jidNormalizedUser(jid);
  const timestamp = Number(raw.messageTimestamp || 0) * 1000;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const message: ReceivedMessage = {
    id: `whatsapp:${chatId}:${id}`,
    provider: "whatsapp",
    providerMessageId: id,
    chatId,
    senderId: jidNormalizedUser(
      raw.key.fromMe && self.id ? self.id : sender(raw) || jid,
    ),
    direction: raw.key.fromMe ? "outgoing" : "incoming",
    type: described.type,
    text: "text" in described ? described.text : undefined,
    timestamp,
  };
  if (revoked) {
    message.deletedAt = timestamp;
    return message;
  }
  if ("media" in described && described.media && Object.keys(described.media).length)
    message.media = described.media;
  if ("field" in described && described.field && content)
    message.mediaSource = mediaSource(content, described.field);
  const reply = content ? quoted(content, self) : null;
  if (reply) message.quoted = reply;
  if (raw.key.fromMe && typeof raw.status === "number") {
    const status = statuses[raw.status];
    if (status) message.status = status;
  }
  return message;
}
/**
 * Reactions synced history carries on the message itself; live reactions
 * arrive as messages.reaction events instead.
 */
export function historyReactions(raw: WAMessage): ReactionUpdate[] {
  if (!raw.key.id || !raw.reactions?.length) return [];
  return raw.reactions.flatMap((r) => {
    const reactor = r.key;
    if (!reactor) return [];
    const senderId = reactor.fromMe
      ? "me"
      : jidNormalizedUser(reactor.participant || reactor.remoteJid || "");
    if (!senderId) return [];
    return [
      {
        providerMessageId: raw.key.id!,
        senderId,
        emoji: r.text || "",
        timestamp: Number(r.senderTimestampMs ?? 0) || Date.now(),
      },
    ];
  });
}
/** A live reaction: `key` is the message reacted to, `reaction.key` the reactor. */
export function normalizeReaction({
  key,
  reaction,
}: {
  key: proto.IMessageKey;
  reaction: proto.IReaction;
}): ReactionUpdate | null {
  if (!key.id) return null;
  const reactor = reaction.key;
  const senderId = reactor?.fromMe
    ? "me"
    : reactor
      ? jidNormalizedUser(reactor.participant || reactor.remoteJid || "")
      : "";
  if (!senderId) return null;
  return {
    providerMessageId: key.id,
    senderId,
    emoji: reaction.text || "",
    timestamp: Number(reaction.senderTimestampMs ?? 0) || Date.now(),
  };
}
/** Baileys reports an edit or a delete for everyone as a messages.update. */
export function normalizeChange({ key, update }: WAMessageUpdate): MessageChange | null {
  if (!key.id) return null;
  const at = millis(update.messageTimestamp) ?? Date.now();
  if (update.messageStubType === WAMessageStubType.REVOKE && update.message === null)
    return { providerMessageId: key.id, kind: "delete", timestamp: Date.now() };
  const edited = update.message?.editedMessage?.message;
  if (edited) {
    const content = normalizeMessageContent(edited);
    const text = content ? describeContent(content).text : undefined;
    if (text !== undefined)
      return { providerMessageId: key.id, kind: "edit", text, timestamp: at };
  }
  return null;
}
