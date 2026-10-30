import type { ImageSize } from "../templates.js";

/** Everything paid goes through these two seams; tests only ever see fakes. */
export interface ImageProvider {
  generate(prompt: string, size: ImageSize): Promise<Buffer>;
  /** Paints over part of a picture (the sky seam band); optional, the seam step falls back without it. */
  edit?(png: Buffer, prompt: string): Promise<Buffer>;
}

export interface ObjectProvider {
  mesh(png: Buffer, name: string): Promise<Buffer>;
}
