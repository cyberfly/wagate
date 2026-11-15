import { useEffect, useState } from "react";
import { getActiveProfile, phoneLabel, request, type GroupMember } from "../lib/api";
/** A person picked from the list: how the composer shows them, and who they are. */
export interface PickedMention {
  /** As typed into the message, such as `@Siti Aminah`. */
  label: string;
  id: string;
}
const cache = new Map<string, { at: number; members: Promise<GroupMember[]> }>();
/** A group's members, asked of WhatsApp once and kept for a few minutes. */
export function useGroupMembers(groupId: string | null, enabled: boolean) {
  const [members, setMembers] = useState<GroupMember[]>([]);
  useEffect(() => {
    setMembers([]);
    if (!groupId || !enabled) return;
    const key = getActiveProfile() + "\n" + groupId;
    let known = cache.get(key);
    if (!known || Date.now() - known.at > 5 * 60_000) {
      known = {
        at: Date.now(),
        members: request<{ members: GroupMember[] }>(
          `/internal/groups/${encodeURIComponent(groupId)}/members`,
        ).then((r) => r.members),
      };
      cache.set(key, known);
      known.members.catch(() => cache.delete(key));
    }
    let live = true;
    known.members.then((list) => live && setMembers(list), () => {});
    return () => {
      live = false;
    };
  }, [groupId, enabled]);
  return members;
}
export function memberName(m: GroupMember) {
  return m.name || phoneLabel(m.phone || m.id);
}
/** The `@word` being typed just before the cursor, if any. */
export function mentionQuery(text: string, caret: number) {
  const match = text.slice(0, caret).match(/(?:^|\s)@([^\s@]{0,30})$/);
  return match ? { start: caret - match[1]!.length - 1, query: match[1]!.toLowerCase() } : null;
}
export function matchingMembers(members: GroupMember[], query: string) {
  const digits = query.replace(/\D/g, "");
  return members
    .filter(
      (m) =>
        memberName(m).toLowerCase().includes(query) ||
        (digits.length > 2 && (m.phone || m.id).includes(digits)),
    )
    .slice(0, 8);
}
/**
 * Turns the names shown in the composer into what WhatsApp sends: `@` and
 * the person's number, with their ids listed beside the text.
 */
export function applyMentions(text: string, picked: PickedMention[]) {
  const mentions: string[] = [];
  // Longer names first, so "@Ali" never claims part of "@Alice".
  for (const p of [...picked].sort((a, b) => b.label.length - a.label.length)) {
    const escaped = p.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const found = new RegExp(escaped + "(?![\\p{L}\\p{N}])", "gu");
    if (!found.test(text)) continue;
    text = text.replace(found, "@" + p.id.split("@")[0]);
    if (!mentions.includes(p.id)) mentions.push(p.id);
  }
  return { text, mentions };
}
export function MentionPicker({
  members,
  active,
  pick,
  hover,
}: {
  members: GroupMember[];
  active: number;
  pick: (m: GroupMember) => void;
  hover: (index: number) => void;
}) {
  return (
    <div className="mention-picker" role="listbox" aria-label="Mention someone">
      {members.map((m, i) => (
        <button
          key={m.id}
          type="button"
          role="option"
          aria-selected={i === active}
          className={i === active ? "active" : ""}
          // Keeps the cursor in the message while choosing.
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => hover(i)}
          onClick={() => pick(m)}
        >
          <strong>{memberName(m)}</strong>
          <small>
            {m.name && m.phone ? phoneLabel(m.phone) : ""}
            {m.admin ? (m.name && m.phone ? " · " : "") + "Admin" : ""}
          </small>
        </button>
      ))}
    </div>
  );
}
