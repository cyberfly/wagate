import { useState } from "react";
import { request } from "../lib/api";
import { openExternal } from "../lib/format";
const termsUrl = "https://github.com/cyberfly/wagate/blob/main/TERMS.md";
/** Shown before anything else until the person agrees to the terms of use. */
export function Terms({ accepted }: { accepted: () => Promise<void> }) {
  const [agreed, setAgreed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const accept = async () => {
    setBusy(true);
    setError("");
    try {
      await request("/internal/terms/accept", "POST");
      await accepted();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="terms-screen">
      <div className="panel" role="dialog" aria-labelledby="terms-title">
        <span className="eyebrow">BEFORE YOU START</span>
        <h2 id="terms-title">Please read this first</h2>
        <ul className="terms-points">
          <li>
            <strong>Wagate is an independent, unofficial app.</strong> It is not
            made, endorsed or supported by WhatsApp or Meta, and it connects as
            a linked device in a way WhatsApp does not officially support.
          </li>
          <li>
            <strong>Your number can be restricted or banned.</strong> WhatsApp
            may limit accounts that use unofficial apps, and is most likely to
            when you send bulk or automated messages. Use a number you can
            afford to lose access to, and start slowly.
          </li>
          <li>
            <strong>Only message people who agreed to hear from you.</strong>{" "}
            You are responsible for what you send with broadcasts, bulk group
            adds, automation and the API, and for following WhatsApp's terms
            and the law where you and your recipients are.
          </li>
          <li>
            <strong>Your data stays on this computer,</strong> stored without
            encryption apart from your sessions and keys. If you turn on AI
            features, recent chat messages are sent to OpenRouter to write
            drafts.
          </li>
          <li>
            <strong>There is no warranty.</strong> Wagate is provided as is,
            and may stop working whenever WhatsApp changes.
          </li>
        </ul>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
          />
          I have read this and accept the risks and the terms of use.
        </label>
        {error ? (
          <p role="alert" className="inline-error">
            {error}
          </p>
        ) : null}
        <div className="button-row">
          <button disabled={!agreed || busy} onClick={() => void accept()}>
            Continue to Wagate
          </button>
          <button className="text-button" onClick={() => openExternal(termsUrl)}>
            Read the full terms
          </button>
        </div>
        <small className="muted">
          If you do not agree, quit Wagate and remove it from Linked Devices
          on your phone.
        </small>
      </div>
    </div>
  );
}
