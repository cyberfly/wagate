import { useEffect, useState } from "react";
import { request } from "../lib/api";
import { openExternal } from "../lib/format";
export interface ComposedLink {
  url: string;
  title: string;
  description?: string;
  /** A small JPEG as base64, sent with the message. */
  thumbnail?: string;
}
interface Looked {
  url: string;
  title: string;
  description: string | null;
  image: { mimetype: string; data: string } | null;
}
const firstLink = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'’]/i;
/** Shrinks a page's picture to the small JPEG WhatsApp shows beside a link. */
function thumbnail(image: { mimetype: string; data: string }) {
  return new Promise<string | undefined>((resolve) => {
    const img = new Image();
    img.onerror = () => resolve(undefined);
    img.onload = () => {
      try {
        const scale = Math.min(1, 320 / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) return resolve(undefined);
        // Transparent pictures get a white background, as JPEG has none.
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
        for (const quality of [0.75, 0.5, 0.3]) {
          const data = canvas.toDataURL("image/jpeg", quality).replace(/^data:[^,]*,/, "");
          if (data.length < 80_000) return resolve(data);
        }
        resolve(undefined);
      } catch {
        resolve(undefined);
      }
    };
    img.src = `data:${image.mimetype};base64,${image.data}`;
  });
}
/**
 * The preview for the first link in a message being written. Looked up
 * shortly after typing stops; dismissing it lasts until the link changes.
 */
export function useLinkPreview(text: string, enabled: boolean) {
  const url = enabled ? (text.match(firstLink)?.[0] ?? null) : null;
  const [found, setFound] = useState<ComposedLink | null>(null),
    [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    setFound(null);
    if (!url || url === dismissed) return;
    let live = true;
    const timer = setTimeout(() => {
      request<{ preview: Looked | null }>("/internal/link-preview?url=" + encodeURIComponent(url))
        .then(async ({ preview }) => {
          if (!preview || !live) return;
          const small = preview.image ? await thumbnail(preview.image) : undefined;
          if (live)
            setFound({
              url,
              title: preview.title,
              description: preview.description ?? undefined,
              thumbnail: small,
            });
        })
        .catch(() => {});
    }, 600);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [url, dismissed]);
  return {
    link: found && found.url === url ? found : null,
    dismiss: () => setDismissed(url),
  };
}
function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
/** A link's page, as a small card: picture, title, description and site. */
export function LinkCard({
  link,
  image,
  open = true,
}: {
  link: { url: string; title?: string; description?: string };
  /** Something an <img> can show. */
  image?: string | null;
  /** Clicking opens the link in the browser. */
  open?: boolean;
}) {
  const body = (
    <>
      {image ? <img src={image} alt="" /> : null}
      <span className="link-text">
        {link.title ? <strong>{link.title}</strong> : null}
        {link.description ? <span>{link.description}</span> : null}
        <small>{host(link.url)}</small>
      </span>
    </>
  );
  return open ? (
    <button
      type="button"
      className={"link-card" + (image ? " has-image" : "")}
      title={link.url}
      onClick={(e) => {
        e.stopPropagation();
        openExternal(link.url);
      }}
    >
      {body}
    </button>
  ) : (
    <div className={"link-card" + (image ? " has-image" : "")}>{body}</div>
  );
}
