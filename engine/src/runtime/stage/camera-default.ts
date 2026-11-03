/**
 * Which camera the runtime films with.
 * CURRENT = K1 moves library + K2 director style (`styles.ts`, move layer in `director.ts`).
 * LEGACY = the pre-K2 frames (director without a style): only on the explicit `?camera_style=legacy`.
 */
export const CURRENT_CAMERA_STYLE = "storybook";

/** `?camera_style=` value -> director style id; undefined = legacy frames */
export function cameraStyleOf(param: string | null | undefined): string | undefined {
  if (param === "legacy") return undefined;
  return param ? param : CURRENT_CAMERA_STYLE;
}
