import { ownedIds, selectedIds } from "./control.mjs?v=0.11.4";
import { defaultAspect, ASPECTS } from "./combat.mjs?v=0.11.4";

export function validSquads(slots, team, groups) {
  const ids = slots.filter(s => s.team === team).map(s => s.id);
  return ids.length === 6 && Array.isArray(groups) && groups.length === 3 && groups.every(g => Array.isArray(g) && g.length === 2) &&
    new Set(groups.flat()).size === 6 && groups.flat().every(id => ids.includes(id));
}
export function teamSquads(state, team) {
  const slots = (state.slots ?? []).filter(s => s.team === team), saved = state.squads?.[team];
  if (validSquads(state.slots ?? [], team, saved)) return saved.map(g => [...g]);
  if (slots.length !== 6) return [];
  const aspect = s => state.pawns?.[s.id]?.aspect ?? state.aspects?.[s.id] ?? defaultAspect(s);
  const groups = [[], [], []], used = new Set();
  const take = (group, condition) => { const slot = slots.find(s => !used.has(s.id) && condition(aspect(s))); if (slot) { groups[group].push(slot.id); used.add(slot.id); } };
  take(0, a => a === "heal"); take(1, a => a === "heal"); take(2, a => a === "support");
  for (let i = 0; i < 3; i++) take(i, a => a === "attack" || a === "defense");
  for (let i = 0; i < 3; i++) while (groups[i].length < 2) take(i, () => true);
  return groups;
}
export function ownedSquads(state, connection) {
  const own = new Set(ownedIds(state, connection));
  return ["red", "blue"].flatMap(team => {
    const groups = teamSquads(state, team);
    return groups.length && groups.flat().every(id => own.has(id)) ? [{ team, groups }] : [];
  });
}
export function memberLabel(state, id) {
  const slot = state.slots.find(s => s.id === id);
  const aspect = state.pawns?.[id]?.aspect ?? state.aspects?.[id] ?? defaultAspect(slot);
  return slot.name.slice(0, 2) + " " + ASPECTS[aspect].short;
}
export function swapMember(groups, group, position, id) {
  const next = groups.map(g => [...g]), previous = next[group]?.[position];
  const source = next.findIndex(g => g.includes(id));
  if (source < 0 || previous === undefined) return next;
  const index = next[source].indexOf(id); next[source][index] = previous; next[group][position] = id;
  return next;
}
export function orderSummary(state, connection) {
  const ids = selectedIds(state, connection), codes = ids.map(id => state.slots.find(s => s.id === id).name.slice(0, 2));
  const orders = ids.map(id => state.pawns?.[id]?.planned || state.pawns?.[id]?.moving ? state.pawns[id].orderPoint ?? "маршрут" : null);
  const destination = orders.length && orders.every(o => o && o === orders[0]) ? orders[0] : orders.some(Boolean) ? "разные маршруты" : "выбери точку";
  return { ids, label: codes.length > 3 ? codes.length + " персонажей: " + codes.slice(0, 2).join(" + ") + "…" : codes.join(" + "), destination };
}
