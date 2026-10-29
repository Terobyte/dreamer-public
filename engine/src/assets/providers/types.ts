import type { ImageSize } from "../templates.js";

/** Everything paid goes through these two seams; tests only ever see fakes. */
export interface ImageProvider {
  generate(prompt: string, size: ImageSize): Promise<Buffer>;
}

export interface ObjectProvider {
  mesh(png: Buffer, name: string): Promise<Buffer>;
}
