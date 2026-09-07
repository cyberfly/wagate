import { useEffect, useState } from "react";
import { request } from "../lib/api";
interface Config {
  ai: {
    model: string;
    systemPrompt: string;
    contextSize: number;
    guardEnabled: boolean;
  };
  hasKey: boolean;
  port: number;
}
export function Settings({
  act,
  busy,
}: {
  act: (fn: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}) {
  const [config, setConfig] = useState<Config | null>(null),
    [apiKey, setApiKey] = useState(""),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    void request<Config>("/internal/settings")
      .then(setConfig)
      .catch((e) => setError(String(e)));
  }, []);
  if (!config)
    return (
      <div className="panel settings-panel">{error || "Loading settings…"}</div>
    );
  const update = (value: Partial<Config["ai"]>) => {
    setSaved(false);
    setConfig({ ...config, ai: { ...config.ai, ...value } });
  };
  return (
    <div className="settings-layout">
      <form
        className="panel settings-panel"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await request("/internal/settings", "PUT", {
              ...config.ai,
              ...(apiKey ? { apiKey } : {}),
            });
            setConfig({ ...config, hasKey: config.hasKey || !!apiKey });
            setApiKey("");
            setSaved(true);
          });
        }}
      >
        <span className="eyebrow">BRING YOUR OWN KEY</span>
        <h2>AI that works with you</h2>
        <p className="muted">
          Connect OpenRouter to draft replies. Copilot stays off until you
          enable it in a conversation.
        </p>
        <label htmlFor="apiKey">
          OpenRouter API key{" "}
          <span className="field-hint">
            {config.hasKey ? "Saved securely" : "Not configured"}
          </span>
        </label>
        <input
          id="apiKey"
          type="password"
          autoComplete="new-password"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            setSaved(false);
          }}
          placeholder={
            config.hasKey ? "Leave blank to keep the saved key" : "sk-or-…"
          }
        />
        <small>
          Encrypted locally with a key held in the OS credential store.
        </small>
        <label htmlFor="model">Model</label>
        <input
          id="model"
          list="models"
          value={config.ai.model}
          required
          onChange={(e) => update({ model: e.target.value })}
        />
        <datalist id="models">
          <option value="openai/gpt-4o-mini" />
          <option value="anthropic/claude-sonnet-4" />
          <option value="google/gemini-2.5-flash" />
        </datalist>
        <small>Enter an OpenRouter provider/model ID.</small>
        <label htmlFor="context">Recent messages in context</label>
        <input
          id="context"
          type="number"
          min="1"
          max="50"
          required
          value={config.ai.contextSize}
          onChange={(e) => update({ contextSize: Number(e.target.value) })}
        />
        <label className="checkbox">
          <input
            type="checkbox"
            checked={config.ai.guardEnabled}
            onChange={(e) => update({ guardEnabled: e.target.checked })}
          />
          Keep Copilot to chat replies
        </label>
        <small>
          Skips messages that ask for code, essays, homework, or that try to
          rewrite Copilot's instructions, before any request reaches OpenRouter.
          Turn this off only if you want Copilot to answer such requests.
        </small>
        <label htmlFor="prompt">Instructions for Copilot</label>
        <textarea
          id="prompt"
          rows={5}
          required
          maxLength={8000}
          value={config.ai.systemPrompt}
          onChange={(e) => update({ systemPrompt: e.target.value })}
        />
        <div className="button-row">
          <button disabled={busy} type="submit">
            Save settings
          </button>
          {saved ? (
            <span role="status" className="saved">
              ✓ Saved
            </span>
          ) : null}
          {config.hasKey ? (
            <button
              className="text-button danger"
              disabled={busy}
              type="button"
              onClick={() =>
                void act(async () => {
                  await request("/internal/settings/key", "DELETE");
                  setConfig({ ...config, hasKey: false });
                })
              }
            >
              Remove key
            </button>
          ) : null}
        </div>
      </form>
      <aside className="settings-aside">
        <h3>Always in your hands</h3>
        <p>Copilot creates a draft. You can edit, dismiss, or approve it.</p>
        <p>
          Only the selected recent conversation context is sent to OpenRouter
          when Copilot runs.
        </p>
        <div className="privacy-note">
          Autopilot is not part of this release. No AI reply is sent without
          your approval.
        </div>
      </aside>
    </div>
  );
}
