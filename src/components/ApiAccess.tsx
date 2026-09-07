import { useEffect, useState } from "react";
import { request, tunnelLabel, type TunnelState } from "../lib/api";
interface Key {
  id: string;
  name: string;
  permissions: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}
const scopes = ["chats.read", "messages.read", "messages.send"];
export function ApiAccess({
  act,
  busy,
  tunnel,
}: {
  act: (fn: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
  tunnel: TunnelState | null | undefined;
}) {
  const [keys, setKeys] = useState<Key[]>([]),
    [name, setName] = useState(""),
    [selected, setSelected] = useState<string[]>([
      "chats.read",
      "messages.read",
    ]),
    [created, setCreated] = useState(""),
    [port, setPort] = useState(8787),
    [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  const active = keys.some((k) => !k.revokedAt);
  const working =
    tunnel?.status === "starting" || tunnel?.status === "installing";
  const load = async () => {
    const result = await request<{ keys: Key[] }>("/internal/keys");
    setKeys(result.keys);
  };
  useEffect(() => {
    void Promise.all([
      load(),
      request<{ port: number }>("/internal/settings").then((s) =>
        setPort(s.port),
      ),
    ]).catch((e) => setError(String(e)));
  }, []);
  return (
    <div className="api-layout">
      <section className="panel settings-panel">
        <span className="eyebrow">CONNECT YOUR TOOLS</span>
        <h2>A gateway on your computer</h2>
        <p className="muted">
          Use scoped API keys to read chats or send messages from your own
          applications.
        </p>
        <div className="endpoint">
          <span className="status online">Local only</span>
          <code>http://127.0.0.1:{port}</code>
        </div>
        {error ? <p role="alert">{error}</p> : null}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const result = await request<{ key: string }>(
                "/internal/keys",
                "POST",
                { name, permissions: selected },
              );
              setCreated(result.key);
              setName("");
              await load();
            });
          }}
        >
          <label htmlFor="keyName">API key name</label>
          <input
            id="keyName"
            required
            maxLength={80}
            placeholder="My local integration"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <fieldset>
            <legend>Permissions</legend>
            {scopes.map((scope) => (
              <label className="checkbox" key={scope}>
                <input
                  type="checkbox"
                  checked={selected.includes(scope)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...selected, scope]
                        : selected.filter((s) => s !== scope),
                    )
                  }
                />
                {scope}
              </label>
            ))}
          </fieldset>
          <button disabled={busy || !selected.length}>Create API key</button>
        </form>
        {created ? (
          <div className="new-key">
            <strong>Save this key now. It is shown only once.</strong>
            <input
              aria-label="New API key"
              readOnly
              value={created}
              onFocus={(e) => e.target.select()}
            />
            <button className="text-button" onClick={() => setCreated("")}>
              I’ve saved it
            </button>
          </div>
        ) : null}
        <div className="key-list">
          {keys.map((k) => (
            <div className="key-row" key={k.id}>
              <div>
                <strong>{k.name}</strong>
                <small>{JSON.parse(k.permissions).join(" · ")}</small>
                <small>
                  {k.revokedAt
                    ? "Revoked"
                    : k.lastUsedAt
                      ? "Last used " + new Date(k.lastUsedAt).toLocaleString()
                      : "Never used"}
                </small>
              </div>
              {!k.revokedAt ? (
                <button
                  className="text-button danger"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await request("/internal/keys/" + k.id, "DELETE");
                      await load();
                    })
                  }
                >
                  Revoke
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </section>
      <section className="panel settings-panel tunnel-panel">
        <span className="eyebrow">PUBLIC ACCESS</span>
        <h2>Reach this gateway from anywhere</h2>
        <p className="muted">
          Cloudflare Tunnel gives the API a public HTTPS address without opening
          a port on your router. Only the API-key routes are published —
          settings, drafts and your WhatsApp session stay on this machine.
        </p>
        <div className="endpoint">
          <span
            className={
              "status " + (tunnel?.status === "online" ? "online" : "")
            }
          >
            {tunnelLabel[tunnel?.status || "off"]}
          </span>
          <code>
            {tunnel?.url || `http://127.0.0.1:${port} (this device only)`}
          </code>
        </div>
        {tunnel?.status === "online" ? (
          <div className="new-key">
            <strong>This address is live on the internet.</strong>
            <input
              aria-label="Public gateway address"
              readOnly
              value={tunnel.url || ""}
              onFocus={(e) => e.target.select()}
            />
            <button
              className="text-button"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(tunnel.url || "")
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? "Copied" : "Copy address"}
            </button>
          </div>
        ) : null}
        {tunnel?.status === "installing" ? (
          <p className="muted">
            Downloading cloudflared… {tunnel.progress ?? 0}%
          </p>
        ) : null}
        {tunnel?.status === "starting" ? (
          <p className="muted">
            Asking Cloudflare for an address. This takes a few seconds.
          </p>
        ) : null}
        {tunnel?.error ? <p className="inline-error">{tunnel.error}</p> : null}
        {tunnel && !tunnel.supported ? (
          <p className="inline-error">
            Cloudflare Tunnel has no cloudflared build for this platform.
          </p>
        ) : null}
        <div className="button-row">
          {tunnel?.status === "online" ? (
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  setCopied(false);
                  await request("/internal/tunnel/stop", "POST");
                })
              }
            >
              Stop public access
            </button>
          ) : tunnel && !tunnel.installed ? (
            <button
              disabled={busy || working || !tunnel.supported}
              onClick={() =>
                void act(() => request("/internal/tunnel/install", "POST"))
              }
            >
              Download cloudflared
            </button>
          ) : (
            <button
              disabled={busy || working || !active}
              onClick={() =>
                void act(() => request("/internal/tunnel/start", "POST"))
              }
            >
              Go public
            </button>
          )}
        </div>
        {!active && tunnel?.status !== "online" ? (
          <p className="muted">
            Create an API key first. Without one every public request is
            rejected.
          </p>
        ) : null}
        <p className="privacy-note">
          Anyone holding a key can read chats and send messages from your
          number, so publish only keys you can revoke. The address changes every
          time you start the tunnel, and it disappears when you stop it or close
          Wagate. Quick tunnels do not stream <code>/v1/events</code>; poll the
          other endpoints instead.
        </p>
      </section>
      <aside className="settings-aside">
        <h3>Send a message</h3>
        <pre>{`curl ${tunnel?.url || `http://127.0.0.1:${port}`}/v1/messages/send \\\n  -H 'Authorization: Bearer YOUR_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"to":"60123456789",\n       "text":"Hello"}'`}</pre>
        <h3>Available endpoints</h3>
        <ul className="endpoint-list">
          <li>GET /health</li>
          <li>GET /v1/status</li>
          <li>GET /v1/chats</li>
          <li>GET /v1/chats/:id/messages</li>
          <li>POST /v1/messages/send</li>
          <li>GET /v1/events</li>
        </ul>
        <p>
          The desktop app must stay open for integrations to work. API keys
          cannot access your OpenRouter key or WhatsApp session.
        </p>
      </aside>
    </div>
  );
}
