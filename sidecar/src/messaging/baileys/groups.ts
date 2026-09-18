import {
  jidNormalizedUser,
  type Contact,
  type GroupMetadata,
} from "@whiskeysockets/baileys";
import type { GroupInfo } from "../types";
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
