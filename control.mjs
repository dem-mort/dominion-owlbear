export const CONTROL_MODES = Object.freeze({
  individual: Object.freeze({ label: "12 игроков · по персонажу", controllers: 12 }),
  teams: Object.freeze({ label: "2 игрока · по команде", controllers: 2 }),
  solo: Object.freeze({ label: "1 игрок · все персонажи", controllers: 1 }),
});

const slotsOf = state => Array.isArray(state?.slots) ? state.slots : [];
const validId = value => typeof value === "string" && value.length > 0;
const validOwner = value => typeof value === "string" && value.length > 0;
const unique = values => [...new Set(values)];

export function modeOf(state) {
  return Object.hasOwn(CONTROL_MODES, state?.controlMode) ? state.controlMode : "individual";
}

export function ownedIds(state, connection) {
  if (!validOwner(connection)) return [];
  return unique(slotsOf(state).filter(slot => validId(slot?.id) && state?.claims?.[slot.id]?.connection === connection).map(slot => slot.id));
}

export function activeId(state, connection) {
  const owned = ownedIds(state, connection);
  const requested = state?.active?.[connection];
  return owned.includes(requested) ? requested : owned[0];
}

export function selectedIds(state, connection) {
  const owned = new Set(ownedIds(state, connection));
  const requested = state?.selections?.[connection];
  const selected = Array.isArray(requested) ? unique(requested.filter(id => owned.has(id))) : [];
  const active = activeId(state, connection);
  return selected.length ? selected : active ? [active] : [];
}

export function claimTargetIds(state, target = {}) {
  const { id, team } = target ?? {};
  const slots = slotsOf(state).filter(slot => validId(slot?.id));
  const mode = modeOf(state);
  if (mode === "solo") return unique(slots.map(slot => slot.id));
  if (mode === "individual") return slots.some(slot => slot.id === id) ? [id] : [];
  const side = ["red", "blue"].includes(team) ? team : slots.find(slot => slot.id === id)?.team;
  return ["red", "blue"].includes(side) ? unique(slots.filter(slot => slot.team === side).map(slot => slot.id)) : [];
}

export function canStart(state) {
  const slots = slotsOf(state);
  const claims = state?.claims ?? {};
  const mode = modeOf(state);
  if (mode === "individual") return slots.some(slot => validId(slot?.id) && validOwner(claims[slot.id]?.connection));

  const ids = slots.map(slot => slot?.id);
  const validRoster = ids.length === 12 && ids.every(validId) && new Set(ids).size === 12;
  if (!validRoster || Object.keys(claims).some(id => !ids.includes(id))) return false;
  const owners = ids.map(id => claims[id]?.connection);
  if (!owners.every(validOwner)) return false;
  if (mode === "solo") return new Set(owners).size === 1;

  const red = slots.filter(slot => slot.team === "red");
  const blue = slots.filter(slot => slot.team === "blue");
  if (red.length !== 6 || blue.length !== 6 || new Set(owners).size !== 2) return false;
  const redOwners = new Set(red.map(slot => claims[slot.id].connection));
  const blueOwners = new Set(blue.map(slot => claims[slot.id].connection));
  return redOwners.size === 1 && blueOwners.size === 1 && [...redOwners][0] !== [...blueOwners][0];
}
