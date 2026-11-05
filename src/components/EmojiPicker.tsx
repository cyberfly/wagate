import { useEffect, useRef, useState } from "react";
import { emojiCategories } from "../lib/emoji";
/** A popover of emoji; closes on Escape or a click outside it. */
export function EmojiPicker({
  pick,
  close,
  className = "",
}: {
  pick: (emoji: string) => void;
  close: () => void;
  className?: string;
}) {
  const [category, setCategory] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    const click = (e: MouseEvent) => {
      if (panel.current && !panel.current.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", key, true);
    // Opened by a click; listen from the next one.
    const timer = setTimeout(() => window.addEventListener("mousedown", click));
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("mousedown", click);
    };
  }, [close]);
  return (
    <div ref={panel} className={"emoji-picker " + className} role="dialog" aria-label="Emoji">
      <div className="emoji-tabs" role="tablist">
        {emojiCategories.map((c, i) => (
          <button
            key={c.name}
            type="button"
            role="tab"
            aria-selected={i === category}
            title={c.name}
            className={i === category ? "active" : ""}
            onClick={() => setCategory(i)}
          >
            {c.emoji[0]}
          </button>
        ))}
      </div>
      <strong>{emojiCategories[category]!.name}</strong>
      <div className="emoji-grid">
        {emojiCategories[category]!.emoji.map((e) => (
          <button key={e} type="button" aria-label={e} onClick={() => pick(e)}>
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}
