import { ownedIds } from "./control.mjs?v=0.8.1";
import { NS } from "./rules.mjs?v=0.8.1";

export const TARGET_KEY = NS + "/map-target";
const VIEW_KEY = NS + "/local-view";
const HOME_KEY = NS + "/lobby-position";
const targetUrl = new URL("./target.svg?v=0.8.1", import.meta.url).href;
const readyUrl = new URL("./target-ready.svg?v=0.8.1", import.meta.url).href;
const finitePosition = position => Number.isFinite(position?.x) && Number.isFinite(position?.y);
const validId = value => typeof value === "string" && value.length > 0;
const TEXT_STYLE = {
  fillColor: "#ffffff", fillOpacity: 0, strokeColor: "#000000", strokeOpacity: 0, strokeWidth: 0,
  textAlign: "CENTER", textAlignVertical: "MIDDLE", fontFamily: "Roboto", fontSize: 12,
  fontWeight: 400, lineHeight: 1, padding: 0,
};

function direction(combatId, pawnId) {
  let hash = 2166136261;
  for (const character of combatId + "\0" + pawnId) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
  return hash % 12;
}

// Both the local image and the pointer tool use this geometry. Five twelfths of
// a turn per round visits every direction before repeating after twelve rounds.
export function targetPosition(fight, pawnId, scale = 1) {
  if (!validId(fight?.id) || !validId(pawnId) || !Number.isSafeInteger(fight.round) || fight.round < 1 ||
      !finitePosition(fight.position) || !Number.isFinite(fight.radius) || fight.radius < 0 ||
      !Number.isFinite(scale) || scale <= 0) return null;
  const angle = ((direction(fight.id, pawnId) + (fight.round % 12) * 5) % 12) * Math.PI / 6;
  const distance = fight.radius + 22 * scale;
  const position = { x: fight.position.x + Math.cos(angle) * distance, y: fight.position.y + Math.sin(angle) * distance };
  const radius = 14 * scale;
  if (!finitePosition(position) || !Number.isFinite(radius)) return null;
  return { key: fight.id + "/" + fight.round + "/" + pawnId, combat: fight.id, round: fight.round, id: pawnId, position, radius };
}

export function hitTarget(target, position) {
  if (!finitePosition(target?.position) || !finitePosition(position) || !Number.isFinite(target.radius) || target.radius <= 0) return false;
  // Adding the radius to a fractional scene coordinate can round outwards.
  // Keep that exact boundary inside without widening the clickable ring.
  const tolerance = 2 * Number.EPSILON * Math.max(1, target.radius,
    Math.abs(target.position.x), Math.abs(target.position.y), Math.abs(position.x), Math.abs(position.y));
  return Math.hypot(position.x - target.position.x, position.y - target.position.y) <= target.radius + tolerance;
}

export function mapTarget(state, connection) {
  if (state?.phase !== "playing" || state.controlMode !== "individual" || state.actionSeconds !== 1 ||
      !Number.isFinite(state.boardScale) || state.boardScale <= 0) return null;
  const owned = ownedIds(state, connection);
  if (owned.length !== 1) return null;
  const id = owned[0], pawn = state.pawns?.[id];
  if (!pawn || pawn.deadUntil) return null;
  const fight = Array.isArray(state.combats) ? state.combats.find(combat => Array.isArray(combat?.members) && combat.members.includes(id)) : null;
  if (!fight || fight.stepSeconds !== 1 || !Number.isFinite(fight.endsAt) ||
      (Number.isFinite(state.elapsed) && fight.endsAt <= state.elapsed)) return null;
  const target = targetPosition(fight, id, state.boardScale);
  return target ? { ...target, ready: Array.isArray(fight.ready) && fight.ready.includes(id) } : null;
}

// Clone an existing native Image schema, restoring the saved class image's
// fields first. This never publishes or edits a shared scene item.
export function targetViews(state, items, connection) {
  const target = mapTarget(state, connection);
  if (!target || !Array.isArray(items)) return [];
  const pawn = items.find(item => item.id === target.id);
  if (!pawn) return [];
  const original = pawn.metadata?.[HOME_KEY] ? { ...pawn, ...pawn.metadata[HOME_KEY] } : pawn;
  if (!original.image) return [];
  const source = TARGET_KEY + "/" + connection;
  const size = 2 * target.radius / 140;
  const item = {
    ...original, type: "IMAGE", name: target.ready ? "Доминион · Действие принято" : "Доминион · Цель действия",
    layer: "NOTE", zIndex: 10000, visible: true, locked: true, disableHit: true,
    image: { url: target.ready ? readyUrl : targetUrl, mime: "image/svg+xml", width: 140, height: 140 },
    grid: { dpi: 150, offset: { x: 70, y: 70 } },
    position: { ...target.position }, rotation: 0, scale: { x: size, y: size },
    text: { type: "PLAIN", plainText: "", richText: [{ type: "paragraph", children: [{ text: "" }] }],
      width: 140, height: 140, style: { ...TEXT_STYLE } },
    metadata: { [VIEW_KEY]: source, [TARGET_KEY]: target.key },
  };
  delete item.attachedTo;
  return [{ source, id: target.id, item }];
}
