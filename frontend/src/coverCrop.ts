export type CoverCrop = {
  /** Source rectangle (in source pixels) that `object-fit: cover` makes visible. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
};

/**
 * The part of a source frame that is visible when it is shown with `object-fit: cover`
 * (centered, i.e. the default `object-position: 50% 50%`) inside a target box.
 *
 * Used so that what the worker sees, what is sent to the AI and the overlay coordinates all
 * refer to the same region (WYSIWYG).
 *
 * - source taller than target: full width, top/bottom cropped symmetrically
 * - source wider than target:  full height, left/right cropped symmetrically
 * - invalid source size  => zero rect (caller should skip the frame)
 * - invalid target size  => the whole source frame (no crop)
 */
export function computeCoverCrop(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number): CoverCrop {
  const valid = (n: number) => Number.isFinite(n) && n > 0;
  if (!valid(sourceWidth) || !valid(sourceHeight)) return { sx: 0, sy: 0, sw: 0, sh: 0 };
  if (!valid(targetWidth) || !valid(targetHeight)) return { sx: 0, sy: 0, sw: Math.round(sourceWidth), sh: Math.round(sourceHeight) };

  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = targetWidth / targetHeight;
  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;
  if (sourceAspect < targetAspect) {
    cropHeight = sourceWidth / targetAspect; // keep full width, crop top/bottom
  } else if (sourceAspect > targetAspect) {
    cropWidth = sourceHeight * targetAspect; // keep full height, crop left/right
  }
  const sw = Math.min(Math.max(1, Math.round(cropWidth)), Math.round(sourceWidth));
  const sh = Math.min(Math.max(1, Math.round(cropHeight)), Math.round(sourceHeight));
  const sx = Math.min(Math.max(0, Math.round((sourceWidth - cropWidth) / 2)), Math.round(sourceWidth) - sw);
  const sy = Math.min(Math.max(0, Math.round((sourceHeight - cropHeight) / 2)), Math.round(sourceHeight) - sh);
  return { sx, sy, sw, sh };
}
