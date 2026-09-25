import { useState, useCallback } from "react";
import { useGateway } from "./hooks/use-gateway";
import { statusLabel } from "./lib/api";
import { Connection } from "./components/Connection";
import { Inbox } from "./components/Inbox";
import { Settings } from "./components/Settings";
import { ApiAccess } from "./components/ApiAccess";
import { Broadcast } from "./components/Broadcast";
import { GroupAutomation } from "./components/GroupAutomation";
import { GroupMembers } from "./components/GroupMembers";
const pages = {
  inbox: {
    label: "Inbox",
    title: "Your inbox",
    subtitle: "One quiet place for your conversations.",
    icon: "▤",
  },
  broadcast: {
    label: "Broadcast",
    title: "Broadcast",
    subtitle: "Reach a whole list, one personal message at a time.",
    icon: "⇉",
  },
  members: {
    label: "Add to group",
    title: "Add to group",
    subtitle: "Bring a whole list into a group you run.",
    icon: "⊕",
  },
  automation: {
    label: "Group automation",
    title: "Group automation",
    subtitle: "Useful posts, at the right time, for each community.",
    icon: "◷",
  },
  connection: {
    label: "WhatsApp",
    title: "WhatsApp connection",
    subtitle: "Link once. Pick up where you left off.",
    icon: "◉",
  },
  settings: {
    label: "AI Copilot",
    title: "AI Copilot",
    subtitle: "A little assistance. You stay in control.",
    icon: "✧",
  },
  api: {
    label: "API access",
    title: "API access",
    subtitle: "Connect your tools to your conversations.",
    icon: "⌘",
  },
};
export default function App() {
  const [page, setPage] = useState<keyof typeof pages>("inbox"),
    [selected, setSelected] = useState<string | null>(null),
    [sidebarMinimized, setSidebarMinimized] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const { snapshot, error, refresh } = useGateway(selected);
  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setNotice("");
      try {
        await fn();
        await refresh();
      } catch (e) {
        setNotice(String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );
  const connected = snapshot?.connection.status === "connected";
  const sending = snapshot?.broadcasts.find((b) => b.status === "running");
  const adding = snapshot?.groupImports.find((i) => i.status === "running");
  return (
    <div
      className={
        "app-shell " +
        (page === "inbox"
          ? "inbox-shell"
          : page === "automation"
            ? "automation-shell"
            : "") +
        (sidebarMinimized ? " sidebar-minimized" : "")
      }
    >
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">w</div>
          <div>
            wagate<span>YOUR LOCAL GATEWAY</span>
          </div>
        </div>
        <button
          className="sidebar-toggle"
          type="button"
          aria-label={
            sidebarMinimized ? "Expand sidebar" : "Collapse sidebar"
          }
          aria-expanded={!sidebarMinimized}
          title={sidebarMinimized ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setSidebarMinimized((minimized) => !minimized)}
        >
          <span aria-hidden="true">{sidebarMinimized ? "›" : "‹"}</span>
        </button>
        <div className="workspace-label">WORKSPACE</div>
        <nav>
          {Object.entries(pages).map(([key, item]) => (
            <button
              className={page === key ? "active" : ""}
              aria-label={item.label}
              aria-current={page === key ? "page" : undefined}
              key={key}
              onClick={() => setPage(key as keyof typeof pages)}
            >
              <span>{item.icon}</span>
              <span className="nav-label">{item.label}</span>
              {key === "inbox" && snapshot?.chats.length ? (
                <small>{snapshot.chats.length}</small>
              ) : null}
              {key === "broadcast" && sending ? (
                <small>
                  {sending.total - sending.pending}/{sending.total}
                </small>
              ) : null}
              {key === "members" && adding ? (
                <small>
                  {adding.members.filter((m) => m.status !== "pending").length}/
                  {adding.members.length}
                </small>
              ) : null}
              <span className="sidebar-tooltip" role="tooltip">
                {item.label}
              </span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-badge">
            <span className="dot" /> Local-first, always
          </div>
          <p>
            On your device.
            <br />
            Under your control.
          </p>
          <small>Wagate v0.1.0</small>
        </div>
      </aside>
      <main>
        {page !== "inbox" ? (
          <>
            <header className="topbar">
              <div>
                <span className="eyebrow">YOUR PRIVATE WORKSPACE</span>
                <h1>{pages[page].title}</h1>
                <p>{pages[page].subtitle}</p>
              </div>
              <button
                className={"status-button " + (connected ? "online" : "")}
                onClick={() => setPage("connection")}
              >
                <span className="dot" />
                {snapshot
                  ? statusLabel[snapshot.connection.status]
                  : "Gateway starting"}
              </button>
            </header>
            <div className="health-strip">
              <span>
                <i className="dot" />
                App <strong>Running</strong>
              </span>
              <span>
                <i className={"dot " + (error ? "bad" : "")} />
                Sidecar{" "}
                <strong>
                  {error ? "Unavailable" : snapshot ? "Running" : "Starting"}
                </strong>
              </span>
              <span>
                Database{" "}
                <strong>
                  {snapshot?.health.database === "connected"
                    ? "Connected"
                    : "Checking"}
                </strong>
              </span>
              <span>
                AI{" "}
                <strong>
                  {snapshot?.health.ai === "configured"
                    ? "Configured"
                    : "Not configured"}
                </strong>
              </span>
            </div>
          </>
        ) : null}
        {error || notice ? (
          <div role="alert" className="alert">
            <span>{notice || error}</span>
            {notice ? (
              <button className="text-button" onClick={() => setNotice("")}>
                Dismiss
              </button>
            ) : (
              <button className="text-button" onClick={() => void refresh()}>
                Retry
              </button>
            )}
          </div>
        ) : null}
        {snapshot?.alerts.at(-1) ? (
          <div className="alert warning" role="status">
            {snapshot.alerts.at(-1)?.error}
          </div>
        ) : null}
        {import.meta.env.DEV && import.meta.env.MODE === "preview" ? (
          <div className="alert warning">
            UI preview · Fictional sample data · No WhatsApp or AI requests
          </div>
        ) : null}
        <div className="page-content">
          {page === "connection" ? (
            <Connection state={snapshot?.connection} busy={busy} act={act} />
          ) : page === "settings" ? (
            <Settings busy={busy} act={act} />
          ) : page === "api" ? (
            <ApiAccess busy={busy} act={act} tunnel={snapshot?.tunnel} />
          ) : page === "automation" ? (
            <GroupAutomation
              configurations={snapshot?.automations || []}
              posts={snapshot?.automationPosts || []}
              connected={connected && !error}
              aiReady={snapshot?.health.ai === "configured"}
              busy={busy}
              act={act}
              openSettings={() => setPage("settings")}
            />
          ) : page === "members" ? (
            <GroupMembers
              imports={snapshot?.groupImports || []}
              connected={connected && !error}
              busy={busy}
              act={act}
            />
          ) : page === "broadcast" ? (
            <Broadcast
              broadcasts={snapshot?.broadcasts || []}
              connected={connected && !error}
              busy={busy}
              act={act}
            />
          ) : (
            <Inbox
              chats={snapshot?.chats || []}
              messages={
                snapshot?.messages.filter((m) => m.chatId === selected) || []
              }
              drafts={
                snapshot?.drafts.filter((d) => d.chatId === selected) || []
              }
              selected={selected}
              select={setSelected}
              connected={connected && !error}
              processing={
                !!selected && !!snapshot?.processing.includes(selected)
              }
              busy={busy}
              act={act}
              connect={() => setPage("connection")}
            />
          )}
        </div>
        {page !== "inbox" ? (
          <footer>
            <span>◈ Messages stored on this device</span>
            <span>No analytics. AI is opt-in.</span>
          </footer>
        ) : null}
      </main>
    </div>
  );
}
