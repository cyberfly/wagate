import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import { Vault } from "../../security/vault";
export function createAuth(vault: Vault) {
  const read = (key: string) => {
    const value = vault.get("wa:" + key);
    return value ? JSON.parse(value, BufferJSON.reviver) : null;
  };
  const creds = read("creds") || initAuthCreds();
  const state: AuthenticationState = {
    creds,
    keys: {
      async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          let value = read(`${type}:${id}`);
          if (type === "app-state-sync-key" && value)
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          if (value) result[id] = value;
        }
        return result;
      },
      async set(data) {
        vault.transaction(() => {
          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries || {})) {
              const key = `wa:${type}:${id}`;
              if (value)
                vault.set(key, JSON.stringify(value, BufferJSON.replacer));
              else vault.delete(key);
            }
          }
        });
      },
    },
  };
  return {
    state,
    saveCreds: () =>
      vault.set("wa:creds", JSON.stringify(creds, BufferJSON.replacer)),
  };
}
