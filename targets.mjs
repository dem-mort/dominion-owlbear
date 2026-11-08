import { ownedIds } from "./control.mjs?v=0.11.2";
import { NS } from "./rules.mjs?v=0.11.2";

export const TARGET_KEY = NS + "/map-target";
const VIEW_KEY = NS + "/local-view";
const HOME_KEY = NS + "/lobby-position";
const finitePosition = position => Number.isFinite(position?.x) && Number.isFinite(position?.y);
const validId = value => typeof value === "string" && value.length > 0;
// SDK 3.1.0 Command enum; callers can supply the imported SDK enum as well.
const PATH_COMMAND = Object.freeze({ MOVE: 0, LINE: 1, CUBIC: 4, CLOSE: 5 });

function direction(combatId, pawnId) {
  let hash = 2166136261;
  for (const character of combatId + "\0" + pawnId) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
  return hash % 12;
}

// Both the local path and the pointer tool use this geometry. Five twelfths of
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
  if (state?.phase !== "playing" || state.recoveryRequired || state.controlMode !== "individual" || state.actionSeconds !== 1 ||
      !Number.isFinite(state.boardScale) || state.boardScale <= 0) return null;
  const owned = ownedIds(state, connection);
  if (owned.length !== 1) return null;
  const id = owned[0], pawn = state.pawns?.[id];
  if (!pawn || pawn.deadUntil) return null;
  const fight = Array.isArray(state.combats) ? state.combats.find(combat => Array.isArray(combat?.members) && combat.members.includes(id)) : null;
  if (!fight || fight.stepSeconds !== 1 || !Number.isFinite(fight.endsAt) ||
      (Number.isFinite(state.elapsed) && fight.endsAt <= state.elapsed)) return null;
  const target = targetPosition(fight, id, state.boardScale);
  return target ? { ...target, remaining: Math.max(0, Math.min(1, fight.endsAt - state.elapsed)), ready: Array.isArray(fight.ready) && fight.ready.includes(id) } : null;
}

// Native paths avoid loading an external SVG into Owlbear's Image renderer.
// Their outer stroke edge and the pointer hit geometry share the same radius.
export function targetViews(state, items, connection, Command = PATH_COMMAND) {
  const target = mapTarget(state, connection);
  if (!target || !Array.isArray(items)) return [];
  const pawn = items.find(item => item.id === target.id);
  if (!pawn) return [];
  const original = pawn.metadata?.[HOME_KEY] ? { ...pawn, ...pawn.metadata[HOME_KEY] } : pawn;
  const source = TARGET_KEY + "/" + connection;
  const size = target.radius / 14;
  const { MOVE: M, LINE: L, CUBIC: C, CLOSE: Z } = Command ?? PATH_COMMAND;
  const circle = radius => {
    const k = radius * .55228475;
    return [[M, 0, -radius], [C, k, -radius, radius, -k, radius, 0],
      [C, radius, k, k, radius, 0, radius], [C, -k, radius, -radius, k, -radius, 0],
      [C, -radius, -k, -k, -radius, 0, -radius], [Z]];
  };
  const glyph = target.ready ? [[M, -7, 0], [L, -2, 5], [L, 8, -6]] : [
    [M, -7, 0], [L, -3, 0], [M, 3, 0], [L, 7, 0],
    [M, 0, -7], [L, 0, -3], [M, 0, 3], [L, 0, 7], ...circle(1),
  ];
  const item = {
    id: pawn.id, createdUserId: original.createdUserId ?? "unknown", lastModified: original.lastModified,
    lastModifiedUserId: original.lastModifiedUserId,
    type: "PATH", name: target.ready ? "Доминион · Действие принято" : "Доминион · Цель действия",
    layer: "NOTE", zIndex: 10000, visible: true, locked: true, disableHit: true,
    position: { ...target.position }, rotation: 0, scale: { x: size, y: size },
    commands: [...circle(12.5), ...glyph], fillRule: "nonzero",
    style: { fillColor: target.ready ? "#092d21" : "#08212c", fillOpacity: .94,
      strokeColor: target.ready ? "#76ffad" : "#5feaff", strokeOpacity: 1, strokeWidth: 3, strokeDash: [] },
    metadata: { [VIEW_KEY]: source, [TARGET_KEY]: target.key },
  };
  const steps = Math.max(1, Math.ceil(48 * target.remaining));
  const arc = Array.from({ length: steps + 1 }, (_, i) => { const a = -Math.PI / 2 + Math.PI * 2 * target.remaining * i / steps; return [i ? L : M, Math.cos(a) * 10.2, Math.sin(a) * 10.2]; });
  const clockKey = source + "/clock";
  const clock = { ...item, name: "Цель · время окна", zIndex: 10001, commands: arc,
    style: { ...item.style, fillOpacity: 0, strokeColor: target.ready ? "#76ffad" : target.remaining <= .3 ? "#ffb0aa" : "#ffd296", strokeWidth: 2.5 }, metadata: { [VIEW_KEY]: clockKey } };
  return [{ source, id: target.id, item }, ...target.ready ? [] : [{ source: clockKey, id: target.id, item: clock }]];
}
