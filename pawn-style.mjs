import { classId } from "./classes.mjs?v=0.11.6";

export const PAWN_DIAMETER = 26;
// Owlbear image coordinates use 150 scene units per grid square. Explicit image
// dimensions and centering avoid inheriting the previous class's token geometry.
export function pawnStyle(slot, boardScale = 1) {
  const scale = Number.isFinite(boardScale) && boardScale > 0 ? boardScale : 1;
  const team = slot.team === "blue" ? "blue" : "red";
  return {
    image: { url: new URL(`./class-${classId(slot)}-${team}.svg`, import.meta.url).href,
      mime: "image/svg+xml", width: 140, height: 140 },
    grid: { dpi: 140 * 150 / PAWN_DIAMETER, offset: { x: 70, y: 70 } },
    scale: { x: scale, y: scale },
  };
}
