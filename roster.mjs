import { CLASSES, classId } from "./classes.mjs?v=0.11.7";
import { ASPECTS } from "./combat.mjs?v=0.11.7";

// Same visibility policy as the map: own team, both teams in solo, both for
// an unassigned referee. Never publish a remote enemy spawn roster to a player.
export function spawnGroups(state, connection, role) {
  if (!state || !["preparing", "playing"].includes(state.phase)) return [];
  const teams = visibleTeams(state, connection, role);
  return teams.map(team => ({ team, members: (state.slots ?? []).filter(s => s.team === team).flatMap(slot => {
    const claim = state.claims?.[slot.id], pawn = state.pawns?.[slot.id];
    if (!claim || !pawn || !pawn.deadUntil && !pawn.atSpawn && state.phase !== "preparing") return [];
    const remaining = Math.max(0, Math.ceil((pawn.deadUntil ?? 0) - (state.elapsed ?? 0)));
    const info = CLASSES[classId(slot)], aspect = ASPECTS[pawn.aspect ?? state.aspects?.[slot.id] ?? "attack"];
    return [{ id: slot.id, code: slot.name.slice(0, 2), name: claim.name || slot.name.slice(0, 2),
      className: info.name, classShort: info.short, aspect: aspect.short, remaining,
      status: remaining ? remaining + " с" : pawn.moving ? "Идёт" : "Готов" }];
  }) }));
}

export function visibleTeams(state, connection, role) {
  const own = (state.slots ?? []).filter(s => state.claims?.[s.id]?.connection === connection);
  const all = state.controlMode === "solo" && own.length > 0 || role === "GM" && !own.length;
  return all ? ["red", "blue"] : own.length ? [own[0].team] : [];
}

export function respawnFields(state, connection, role) {
  return spawnGroups(state, connection, role).flatMap(group => {
    const red = group.team === "red", x = red ? 59 : 681, y = red ? 334 : 729;
    const fields = [{ id: "spawn-heading-" + group.team, text: "НА РЕСПЕ · " + group.members.length,
      x: red ? 62 : 686, y: red ? 307 : 702, width: 170, height: 25, size: 13, weight: 700,
      color: red ? "#ffb0aa" : "#9adeff", layer: "NOTE" }];
    if (!group.members.length) fields.push({ id: "spawn-empty-" + group.team, text: "Никого нет", x, y, width: 188, height: 20, size: 12, color: "#a8bac8" });
    for (const [i, member] of group.members.entries()) {
      fields.push({ id: "spawn-name-" + member.id, text: member.code + " " + member.name.slice(0, 11) + " · " + member.classShort + " " + member.aspect,
        x, y: y + i * 20, width: 156, height: 18, size: 10.5, weight: 600, color: "#e8f0f5" });
      fields.push({ id: "spawn-time-" + member.id, text: member.status, x: x + 156, y: y + i * 20, width: 32, height: 18,
        size: 10.5, align: "RIGHT", color: member.remaining ? "#ffd296" : "#a7e2c4" });
    }
    return fields;
  });
}
