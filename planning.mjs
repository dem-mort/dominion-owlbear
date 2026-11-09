import { visibleTeams } from "./roster.mjs?v=0.11.8";
const VIEW_KEY = "ru.allods.dominion/local-view";
export function planViews(state, items, connection, role, Command) {
  if (state?.phase !== "preparing" || state.recoveryRequired || !Command) return [];
  const teams = visibleTeams(state, connection, role), scale = state.boardScale ?? 1;
  const { MOVE: M, LINE: L } = Command;
  return (state.slots ?? []).flatMap((slot, i) => {
    if (!teams.includes(slot.team) || !state.pawns?.[slot.id]?.planned) return [];
    const source = items.find(item => item.id === slot.id), to = state.checkpoint?.pawns?.[i]?.[2];
    if (!source || !Number.isFinite(source.position?.x) || !Number.isFinite(source.position?.y) || !Array.isArray(to) || to.length !== 2 || !to.every(Number.isFinite)) return [];
    const from = source.position, angle = Math.atan2(to[1] - from.y, to[0] - from.x), length = 10 * scale;
    const arrow = sign => [to[0] - Math.cos(angle + sign * Math.PI / 6) * length, to[1] - Math.sin(angle + sign * Math.PI / 6) * length];
    const key = VIEW_KEY + "/plan/" + slot.id;
    return [{ source: key, item: { id: slot.id, createdUserId: source.createdUserId ?? "unknown", type: "PATH",
      name: "Приказ на старт · " + slot.name, layer: "NOTE", zIndex: 5000, visible: true, locked: true, disableHit: true,
      position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 }, fillRule: "nonzero",
      commands: [[M, from.x, from.y], [L, ...to], [M, ...arrow(-1)], [L, ...to], [L, ...arrow(1)]],
      style: { fillColor: "#000000", fillOpacity: 0, strokeColor: slot.team === "red" ? "#ffb0aa" : "#9adeff",
        strokeOpacity: .9, strokeWidth: 2 * scale, strokeDash: [6 * scale, 4 * scale] }, metadata: { [VIEW_KEY]: key } } }];
  });
}
