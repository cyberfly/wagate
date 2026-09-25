// Opt-in live QR check. Creates no linked account and sends no messages.
import { openDatabase } from "../sidecar/src/db/database";
import { Vault } from "../sidecar/src/security/vault";
import { BaileysProvider } from "../sidecar/src/messaging/baileys/baileys-provider";
const db = openDatabase(":memory:");
const vault = new Vault(db, Buffer.alloc(32, 9));
let finish!: (success: boolean) => void;
const result = new Promise<boolean>((resolve) => (finish = resolve));
const provider = new BaileysProvider(async () => vault, {
  connection: (state) => {
    console.log("Connection:", state.status);
    if (state.status === "qr_required")
      finish(!!state.qr?.startsWith("data:image/png;base64,"));
    if (state.status === "auth_error") finish(false);
  },
  chat: () => {},
  receipt: () => {},
  contacts: () => {},
  phones: () => {},
  message: () => {},
  error: () => finish(false),
});
try {
  await provider.connect();
  const success = await Promise.race([
    result,
    Bun.sleep(45000).then(() => false),
  ]);
  if (!success) throw new Error("No QR received within 45 seconds");
  console.log(
    "PASS: WhatsApp returned a pairing QR. No account was paired and no message was sent.",
  );
} finally {
  await provider.disconnect();
  db.close();
}
process.exit(0);
