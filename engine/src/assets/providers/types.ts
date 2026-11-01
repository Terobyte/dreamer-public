import type { ImageSize } from "../templates.js";

/** Everything paid goes through these two seams; tests only ever see fakes. */
export interface ImageProvider {
  generate(prompt: string, size: ImageSize): Promise<Buffer>;
  /** Paints over part of a picture (the sky seam band); optional, the seam step falls back without it. */
  edit?(png: Buffer, prompt: string): Promise<Buffer>;
  /** Redraws one thing cut out of a reference picture (an object asset's `ref`); optional, without it the asset is drawn from text and reported `REF_IGNORED`. */
  fromRef?(ref: { bytes: Buffer; what: string }, prompt: string, size: ImageSize): Promise<Buffer>;
}

/** What `fromScene` hands back: the mesh and the pose SAM3D put it in (only written to `build.json`). */
export interface SceneMesh {
  glb: Buffer;
  pose?: object | null;
}

/** `fromScene` found nothing worth cutting (empty mask, or under 0.5% of the frame): the asset goes the Н2 way. */
export class MaskEmptyError extends Error {
  readonly code = "MASK_EMPTY";
  constructor(msg = "MASK_EMPTY") {
    super(msg);
  }
}

/** The mask came back but SAM3D failed on it: an ordinary mesh failure, never a fallback to Н2. */
export class MaskMeshError extends Error {
  readonly code = "MASK_MESH";
}

export interface ObjectProvider {
  mesh(png: Buffer, name: string): Promise<Buffer>;
  /**
   * Cuts `what` out of the frame of the place (SAM 3 mask) and meshes it with
   * that mask (SAM3D). Throws `MaskEmptyError` for an empty mask and
   * `MaskMeshError` when SAM3D fails after the mask; anything else is a
   * segmentation failure and the asset falls back to the Н2 path.
   */
  fromScene?(scene: { bytes: Buffer; what: string }, size: ImageSize): Promise<SceneMesh>;
}
