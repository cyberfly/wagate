import { useState } from "react";
/** Gaps in seconds. The sidecar accepts 5–600. */
export const paces = [
  { key: "careful", label: "Careful", min: 30, max: 60, note: "Safest for a new number or people who may not know you." },
  { key: "balanced", label: "Balanced", min: 10, max: 20, note: "A sensible default for most lists." },
  { key: "quick", label: "Quick", min: 5, max: 10, note: "Only for people who expect to hear from you." },
] as const;
export function paceValid(min: number, max: number) {
  return (
    Number.isInteger(min) &&
    Number.isInteger(max) &&
    min >= 5 &&
    max <= 600 &&
    min <= max
  );
}
/** Preset gaps between sends, or a custom range. */
export function PaceChooser({
  id,
  label,
  minDelay,
  maxDelay,
  onChange,
}: {
  id: string;
  label: string;
  minDelay: number;
  maxDelay: number;
  onChange: (minDelay: number, maxDelay: number) => void;
}) {
  const preset = paces.find((p) => p.min === minDelay && p.max === maxDelay);
  // Custom stays chosen even when its numbers happen to match a preset.
  const [custom, setCustom] = useState(!preset);
  const chosen = custom ? null : preset;
  return (
    <>
      <label id={id}>{label}</label>
      <div className="column-chips" role="radiogroup" aria-labelledby={id}>
        {paces.map((p) => (
          <button
            type="button"
            role="radio"
            aria-checked={chosen === p}
            key={p.key}
            className={"chip" + (chosen === p ? " active" : "")}
            onClick={() => {
              setCustom(false);
              onChange(p.min, p.max);
            }}
          >
            {p.label} · {p.min}–{p.max} s
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={!chosen}
          className={"chip" + (!chosen ? " active" : "")}
          onClick={() => setCustom(true)}
        >
          Custom
        </button>
      </div>
      {chosen ? (
        <small>{chosen.note}</small>
      ) : (
        <div className="delay-row">
          <input
            aria-label="Minimum wait in seconds"
            type="number"
            min={5}
            max={600}
            value={minDelay}
            onChange={(e) => onChange(Number(e.target.value), maxDelay)}
          />
          <span>to</span>
          <input
            aria-label="Maximum wait in seconds"
            type="number"
            min={5}
            max={600}
            value={maxDelay}
            onChange={(e) => onChange(minDelay, Number(e.target.value))}
          />
          <span>seconds</span>
        </div>
      )}
    </>
  );
}
