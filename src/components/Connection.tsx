import { useState } from "react";
import {
  request,
  statusLabel,
  displayName,
  type ConnectionState,
} from "../lib/api";
export function Connection({
  state,
  busy,
  act,
}: {
  state?: ConnectionState;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const status = state?.status || "disconnected";
  // window.confirm is a no-op in the Tauri webview, so confirm in-app.
  const [confirmingReset, setConfirmingReset] = useState(false);
  return (
    <section className="connection-layout">
      <div>
        <span className="eyebrow">ONE ACCOUNT. ON YOUR DEVICE.</span>
        <h2>Connect your WhatsApp</h2>
        <p className="muted">
          Your conversations stay on this computer. Link your account to start
          receiving and sending messages.
        </p>
        <ol className="steps">
          <li>
            <span>1</span>
            <div>
              <strong>Open WhatsApp on your phone</strong>
              <p>Use the account you want to connect.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Go to Linked Devices</strong>
              <p>Open Settings or the ⋮ menu, then choose Link a Device.</p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Scan the QR code</strong>
              <p>Your session is saved securely for the next launch.</p>
            </div>
          </li>
        </ol>
        <div className="privacy-note">
          ◈ &nbsp; Local storage · No analytics · You control AI access
        </div>
      </div>
      <div className="panel pairing">
        <span className={"status " + (status === "connected" ? "online" : "")}>
          {statusLabel[status]}
        </span>
        {state?.qr ? (
          <img className="qr" src={state.qr} alt="WhatsApp pairing QR code" />
        ) : (
          <div className="pairing-symbol">
            {status === "connected" ? "✓" : "▦"}
          </div>
        )}
        <h3>
          {status === "connected" ? "You’re connected" : "A private connection"}
        </h3>
        <p className="muted">
          {status === "connected"
            ? displayName(state?.account || "WhatsApp account")
            : status === "qr_required"
              ? "Scan this code with WhatsApp Linked Devices."
              : "Start the connection to generate a pairing code."}
        </p>
        {state?.error ? (
          <p role="alert" className="inline-error">
            {state.error}
          </p>
        ) : null}
        {confirmingReset ? (
          <div className="confirm-box" role="alertdialog">
            <strong>Unlink this session?</strong>
            <p>You will need to scan a QR code again to reconnect.</p>
            <div className="button-row">
              <button
                disabled={busy}
                onClick={() => {
                  setConfirmingReset(false);
                  void act(() =>
                    request("/internal/connection/logout", "POST"),
                  );
                }}
              >
                Reset session
              </button>
              <button
                className="secondary"
                onClick={() => setConfirmingReset(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="button-row">
            {status === "disconnected" || status === "auth_error" ? (
              <button
                disabled={busy || status === "auth_error"}
                onClick={() =>
                  void act(() =>
                    request("/internal/connection/connect", "POST"),
                  )
                }
              >
                Connect WhatsApp
              </button>
            ) : (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    request("/internal/connection/disconnect", "POST"),
                  )
                }
              >
                Disconnect
              </button>
            )}
            {status === "auth_error" || status === "connected" ? (
              <button
                className="text-button danger"
                disabled={busy}
                onClick={() => setConfirmingReset(true)}
              >
                Reset session
              </button>
            ) : null}
          </div>
        )}
        <small>Disconnect pauses the connection and keeps your session.</small>
      </div>
    </section>
  );
}
