export type AssetKind = "tile" | "decal" | "object";
export type ImageSize = "1024x1024" | "2048x1024" | "1024x2048";

/**
 * The engine owns the framing, the author owns the subject: these three
 * strings are what every generated asset has in common.
 */
const TEMPLATES: Record<AssetKind, string> = {
  object: "single object, front view facing the camera, whole object, plain white background, no shadow",
  tile: "seamless tileable texture, orthographic front view, flat even lighting, no shadows, no perspective, the pattern repeats with no visible edges",
  decal: "orthographic front view, flat even lighting, centred, filling the frame, plain flat white background",
};

export function promptFor(kind: AssetKind, prompt: string): string {
  return `${TEMPLATES[kind]}. ${prompt}`;
}

/** Only three canvases exist; anything not clearly wide or tall is square. */
export function sizeFor(aspect: string): ImageSize {
  const [w, h] = aspect.split(":").map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return "1024x1024";
  const r = w / h;
  if (r >= 1.5) return "2048x1024";
  if (r <= 1 / 1.5) return "1024x2048";
  return "1024x1024";
}
