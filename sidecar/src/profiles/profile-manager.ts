import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { ConnectionState, ConnectionStatus } from "../messaging/types";
import type { ProfileRuntime, Logger } from "./profile-runtime";
/** The main profile: its data is the original database and it cannot be removed. */
export const defaultProfile = "default";
/** Each profile holds its own WhatsApp connection, so the count is bounded. */
export const maxProfiles = 10;
export interface Profile {
  id: string;
  name: string;
  /** The WhatsApp number last linked to this profile, as a JID. */
  account: string | null;
  createdAt: number;
  isDefault: boolean;
  status: ConnectionStatus;
  /** Set when the profile's data could not be opened. */
  error?: string;
}
interface Row {
  id: string;
  name: string;
  account: string | null;
  created_at: number;
}
export interface ProfileManagerOptions {
  /** Builds the runtime for a profile over its open database. */
  runtime: (id: string, db: Database) => ProfileRuntime;
  /** Opens, creating if needed, the database of a profile other than the main one. */
  open: (id: string) => Database;
  /** Deletes a removed profile's files. Its database is already closed. */
  destroy: (id: string) => void;
  /** Called after a profile is removed, so keys can forget it. */
  removed?: (id: string) => void;
  log: Logger;
  /** How long removing a connected profile waits to unlink it from the phone. */
  logoutTimeout?: number;
}
function cleanName(value: unknown) {
  if (typeof value !== "string") throw new Error("Profile name is required");
  const name = value.replace(/\s+/g, " ").trim();
  if (!name || name.length > 40)
    throw new Error("Profile name must be 1–40 characters");
  return name;
}
/**
 * The WhatsApp numbers this app runs. The registry lives in the main database;
 * each profile's runtime is started at launch and kept until it is removed.
 */
export class ProfileManager {
  private runtimes = new Map<string, ProfileRuntime>();
  private failed = new Set<string>();
  private removing = new Set<string>();
  private started = false;
  constructor(
    private db: Database,
    private o: ProfileManagerOptions,
  ) {}
  /**
   * Opens every profile without touching the network. One that cannot open
   * does not stop the rest; it is listed with an error.
   */
  load() {
    for (const row of this.rows()) {
      if (this.runtimes.has(row.id)) continue;
      try {
        this.attach(
          row.id,
          row.id === defaultProfile ? this.db : this.o.open(row.id),
        );
      } catch {
        this.failed.add(row.id);
        this.o.log("error", "profile.open.failed", { profile: row.id });
      }
    }
  }
  /** Starts schedulers and reconnects the profiles that were left connected. */
  start() {
    this.load();
    this.started = true;
    for (const runtime of this.runtimes.values()) runtime.start();
  }
  /** Every open profile database, the main one first. */
  databases() {
    return [...this.runtimes.values()].map((r) => r.db);
  }
  private rows() {
    return this.db
      .query(
        "SELECT id,name,account,created_at FROM profiles ORDER BY id<>'default', created_at, name",
      )
      .all() as Row[];
  }
  private row(id: string) {
    return this.db
      .query("SELECT id,name,account,created_at FROM profiles WHERE id=?")
      .get(id) as Row | null;
  }
  private attach(id: string, db: Database) {
    const runtime = this.o.runtime(id, db);
    runtime.events.subscribe((event) => {
      if (event.type === "messaging.connection")
        this.connected(id, event.data as ConnectionState);
    });
    this.runtimes.set(id, runtime);
    if (this.started) runtime.start();
    return runtime;
  }
  /** Remembers the linked number and warns when another profile has it too. */
  private connected(id: string, state: ConnectionState) {
    if (state.status !== "connected" || !state.account) return;
    const row = this.row(id);
    if (!row) return;
    if (row.account !== state.account)
      this.db
        .query("UPDATE profiles SET account=? WHERE id=?")
        .run(state.account, id);
    const twin = this.rows().find(
      (r) => r.id !== id && r.account === state.account,
    );
    if (twin)
      this.runtimes.get(id)?.events.publish("profile.error", {
        error: `This WhatsApp number is also linked in the “${twin.name}” profile. Both receive the same messages; reset the session in one of them to use another number.`,
      });
  }
  get(id: string) {
    return this.removing.has(id) ? undefined : this.runtimes.get(id);
  }
  /** The main profile, which always exists. */
  main() {
    const runtime = this.runtimes.get(defaultProfile);
    if (!runtime) throw new Error("Main profile is unavailable");
    return runtime;
  }
  list(): Profile[] {
    return this.rows()
      .filter((row) => !this.removing.has(row.id))
      .map((row) => this.summary(row));
  }
  describe(id: string): Profile | null {
    const row = this.row(id);
    return row && !this.removing.has(id) ? this.summary(row) : null;
  }
  private summary(row: Row): Profile {
    const runtime = this.runtimes.get(row.id);
    const state = runtime?.provider.getConnectionState();
    return {
      id: row.id,
      name: row.name,
      account: state?.account || row.account,
      createdAt: row.created_at,
      isDefault: row.id === defaultProfile,
      status: state?.status ?? "disconnected",
      ...(this.failed.has(row.id)
        ? {
            error:
              "Profile data could not be opened. Check local storage, then restart Wagate.",
          }
        : {}),
    };
  }
  private assertUnique(name: string, except?: string) {
    if (
      this.rows().some(
        (r) => r.id !== except && r.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new Error(`Profile “${name}” already exists`);
  }
  create(value: unknown): Profile {
    const name = cleanName(value);
    this.assertUnique(name);
    if (this.rows().length >= maxProfiles)
      throw new Error(
        `Profile limit reached: Wagate runs up to ${maxProfiles} numbers`,
      );
    const id = "p_" + randomBytes(6).toString("hex");
    let db: Database | undefined;
    try {
      db = this.o.open(id);
      this.db
        .query("INSERT INTO profiles(id,name,created_at) VALUES(?,?,?)")
        .run(id, name, Date.now());
      this.attach(id, db);
    } catch {
      this.db.query("DELETE FROM profiles WHERE id=?").run(id);
      try {
        db?.close();
        this.o.destroy(id);
      } catch {
        /* nothing more to undo */
      }
      this.o.log("error", "profile.create.failed");
      throw new Error("Profile could not be created. Check local storage.");
    }
    this.o.log("info", "profile.created", { profile: id });
    return this.describe(id)!;
  }
  rename(id: string, value: unknown): Profile {
    const name = cleanName(value);
    if (!this.describe(id)) throw new Error("Profile not found");
    this.assertUnique(name, id);
    this.db.query("UPDATE profiles SET name=? WHERE id=?").run(name, id);
    return this.describe(id)!;
  }
  /**
   * Stops a profile, unlinks it from the phone when it is connected, and
   * deletes its chats, messages, broadcasts and session from this computer.
   */
  async remove(id: string) {
    const profile = this.describe(id);
    if (!profile) throw new Error("Profile not found");
    if (profile.isDefault)
      throw new Error(
        `Profile “${profile.name}” is the main profile and cannot be removed; reset its session instead`,
      );
    this.removing.add(id);
    try {
      const runtime = this.runtimes.get(id);
      let unlinked = false;
      if (runtime?.provider.getConnectionState().status === "connected") {
        let timer: ReturnType<typeof setTimeout> | undefined;
        unlinked = await Promise.race([
          runtime.provider.logout().then(() => true),
          new Promise<boolean>((done) => {
            timer = setTimeout(
              () => done(false),
              this.o.logoutTimeout ?? 10000,
            );
          }),
        ])
          .catch(() => false)
          .finally(() => clearTimeout(timer));
      }
      if (runtime) {
        await runtime.close();
        runtime.db.close();
      }
      this.runtimes.delete(id);
      this.failed.delete(id);
      this.db.query("DELETE FROM profiles WHERE id=?").run(id);
      this.o.removed?.(id);
      this.o.destroy(id);
      this.o.log("info", "profile.removed", { profile: id });
      return { success: true, unlinked };
    } finally {
      this.removing.delete(id);
    }
  }
  /** Stops every profile and closes the databases of all but the main one. */
  async close() {
    await Promise.all(
      [...this.runtimes.values()].map((r) => r.close().catch(() => {})),
    );
    for (const [id, runtime] of this.runtimes)
      if (id !== defaultProfile) runtime.db.close();
    this.runtimes.clear();
  }
}
