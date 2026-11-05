import { createPanel } from "./panel-ui.mjs?v=0.7.0";
import { modeOf, ownedIds, claimTargetIds, canStart } from "./control.mjs?v=0.7.0";
const classes = ["Воин", "Храмовник", "Разведчик", "Жрец", "Маг", "Бард"];
const slots = ["К", "С"].flatMap(prefix => classes.map((name, index) => ({ id: prefix + (index + 1), name: prefix + (index + 1) + " · " + name, team: prefix === "К" ? "red" : "blue" })));
const aspects = Object.fromEntries(slots.map(slot => [slot.id, slot.name.endsWith("Жрец") ? "heal" : slot.name.endsWith("Бард") ? "support" : "attack"]));
let current, panel;
const mine = "К4";
const picked = () => ({ [mine]: { connection: "local", name: "Игрок" }, С1: { connection: "other", name: "Александр" } });
const ownerClaims = mode => Object.fromEntries(slots.map(slot => [slot.id, { connection: mode === "solo" || slot.team === "red" ? "local" : "other", name: slot.team === "red" || mode === "solo" ? "Игрок" : "Соперник" }]));
function addMatch(state) {
  Object.assign(state, { elapsed: 123, score: { red: 380, blue: 420 }, nextWave: 150, routeSeconds: 10, calibrated: false,
    points: [{ name: "Трефа", team: "red" }, { name: "Капля", team: "blue" }, { name: "Звезда", team: null }],
    pets: [{ name: "Б1", available: true }, { name: "Б2", available: false }, { name: "Б3", available: false }],
    pawns: Object.fromEntries(Object.keys(state.claims).map(id => [id, { hp: 76, aspect: state.aspects[id], pet: id === mine, moving: false, deadUntil: 0 }])), combats: [] });
}
function makeState(scenario) {
  const mode = scenario.startsWith("teams") ? "teams" : scenario.startsWith("solo") ? "solo" : "individual";
  const lobby = ["lobby", "selected", "player", "teams-lobby", "teams-ready", "solo-lobby", "solo-ready"].includes(scenario);
  const empty = ["lobby", "teams-lobby", "solo-lobby"].includes(scenario);
  const claims = empty ? {} : mode === "individual" ? picked() : ownerClaims(mode);
  const state = { rules: "0.7.0", board: "preview", host: scenario === "player" ? "other" : "local", slots, aspects: { ...aspects }, controlMode: mode,
    active: empty ? {} : { local: mine }, selections: empty ? {} : { local: [mine] }, claims, phase: lobby ? "lobby" : scenario === "finished" ? "finished" : "playing" };
  if (!lobby) addMatch(state);
  if (scenario.includes("preparing")) {
    state.phase = "preparing"; state.elapsed = 0; state.score = { red: 0, blue: 0 }; state.nextWave = 30;
    state.points.forEach(point => { point.team = null; });
    Object.values(state.pawns).forEach(pawn => { pawn.hp = 100; pawn.pet = false; });
    const required = [...new Set(Object.values(state.claims).map(claim => claim.connection))];
    state.preparation = { remaining: scenario === "preparing-ready" ? 37 : 60, required, ready: scenario === "preparing-ready" ? ["local"] : [] };
    if (scenario === "preparing-spectator") { state.claims = { С1: { connection: "other", name: "Александр" } }; state.preparation.required = ["other"]; }
  }
  if (scenario.endsWith("-recovery")) state.host = "other";
  if (scenario === "moving") state.pawns[mine].moving = true;
  if (scenario === "dead") { state.pawns[mine].deadUntil = 146; state.pawns[mine].deathReason = "inactive"; }
  const fight = (id, name, members) => ({ id, name, kind: "point", round: 2, endsAt: 126, members, numbers: [2, 2], counts: [{ attack: 1, support: 0, heal: 1 }, { attack: 1, support: 1, heal: 0 }], ready: [], empowered: members.includes(mine) ? [mine] : [], previous: null });
  if (["combat", "ready", "missed"].includes(scenario)) {
    state.combats = [fight("fight", "Капля", [mine, "С1"])];
    state.combats[0].ready = scenario === "ready" ? [mine] : [];
    state.combats[0].previous = { results: [{ id: mine, active: scenario !== "missed", damage: 4, healing: 22, boost: 0 }] };
  }
  if (scenario.endsWith("-combats")) state.combats = [fight("fight-A", "Капля", ["К1", "К2", "С1", "С2"]), fight("fight-B", "Звезда", ["К3", "К4", "С3", "С4"])];
  if (scenario.startsWith("teams-capture-")) {
    const paused = scenario.endsWith("paused"), rollback = scenario.endsWith("rollback");
    const point = state.points.find(point => point.name === "Капля");
    Object.assign(point, { team: rollback ? "blue" : null, capturing: "red", progress: 42, captureRate: paused ? 0 : (rollback ? -1 : 1) * 100 / 30 });
    const members = rollback ? [mine, "С1", "С2", "С3"] : paused ? ["К1", mine, "С1"] : ["К1", "К2", mine, "С1"];
    state.combats = [fight("capture-fight", "Капля", members)];
    state.combats[0].numbers = rollback ? [1, 3] : paused ? [2, 1] : [3, 1];
    state.combats[0].counts = [{ attack: rollback ? 0 : paused ? 1 : 2, support: 0, heal: 1 }, { attack: rollback ? 3 : 1, support: 0, heal: 0 }];
  }
  if (scenario === "spectator") state.claims = { С1: { connection: "other", name: "Александр" } };
  if (scenario.startsWith("finished")) { state.phase = "finished"; state.winner = "blue"; state.score.blue = 1020; state.elapsed = 600; }
  return state;
}
async function send(command) {
  if (command.type === "set-control-mode") { current.controlMode = command.mode; current.claims = {}; current.active = {}; current.selections = {}; }
  if (command.type === "claim") {
    const ids = claimTargetIds(current, command);
    if (ids.some(id => current.claims[id] && current.claims[id].connection !== "local")) return;
    for (const id of ownedIds(current, "local")) delete current.claims[id];
    for (const id of ids) current.claims[id] = { connection: "local", name: "Игрок" };
    current.active.local = ids.includes(command.id) ? command.id : ids[0]; current.selections.local = [current.active.local];
  }
  if (command.type === "release") for (const id of modeOf(current) === "individual" ? [command.id] : ownedIds(current, "local")) delete current.claims[id];
  if (command.type === "select-pawns") { current.active.local = command.id; current.selections.local = command.ids; }
  if (command.type === "set-aspect") current.aspects[command.id] = command.aspect;
  if (command.type === "take-host") current.host = "local";
  if (command.type === "combat-click") {
    const fight = current.combats.find(fight => fight.id === command.combat);
    for (const id of fight.members.filter(id => current.claims[id]?.connection === "local")) if (!fight.ready.includes(id)) fight.ready.push(id);
  }
  if (command.type === "retreat") { for (const id of command.ids) current.pawns[id].retreating = true; current.combats = current.combats.filter(fight => !command.ids.some(id => fight.members.includes(id))); }
  if (command.type === "move-to-point") { for (const id of command.ids) current.pawns[id].moving = true; }
  if (command.type === "start") {
    if (command.practice) { current.claims = { К1: { connection: "local", name: "К1" } }; current.active.local = "К1"; current.selections.local = ["К1"]; }
    else if (!canStart(current)) return;
    current.phase = command.practice ? "playing" : "preparing"; addMatch(current); current.practice = Boolean(command.practice);
    if (!command.practice) {
      current.elapsed = 0; current.score = { red: 0, blue: 0 }; current.nextWave = 30;
      current.points.forEach(point => { point.team = null; });
      Object.values(current.pawns).forEach(pawn => { pawn.hp = 100; pawn.pet = false; });
      current.preparation = { remaining: 60, required: [...new Set(Object.values(current.claims).map(claim => claim.connection))], ready: [] };
    }
  }
  if (command.type === "ready-early" && current.phase === "preparing" && current.preparation.required.includes("local")) {
    if (!current.preparation.ready.includes("local")) current.preparation.ready.push("local");
    if (current.preparation.required.every(id => current.preparation.ready.includes(id))) { current.phase = "playing"; delete current.preparation; }
  }
  if (["lobby", "recover-lobby"].includes(command.type)) { current.phase = "lobby"; current.combats = []; current.host = "local"; delete current.preparation; }
  panel.update(structuredClone(current));
}
const pristinePanel = document.querySelector("main").cloneNode(true);
panel = createPanel({ connection: "local", name: "Игрок", host: true, send });
const scenario = document.getElementById("preview-state");
for (const [value, label] of [["preparing", "Подготовка · 1:00"], ["preparing-ready", "Подготовка · ты готов"], ["preparing-spectator", "Подготовка · ведущий без фишки"], ["preparing-recovery", "Подготовка · другой ведущий"], ["solo-preparing", "Подготовка · один за 12"], ["teams-preparing", "Подготовка · две команды"], ["playing-recovery", "Матч · другой ведущий"], ["finished-recovery", "Итог · другой ведущий"]]) {
  const option = document.createElement("option"); option.value = value; option.textContent = label; scenario.append(option);
}
for (const [value, label] of [["teams-capture-contested", "Захват · перевес 3:1"], ["teams-capture-paused", "Захват · пауза 2:1"], ["teams-capture-rollback", "Захват · откат 1:3"]]) {
  const option = document.createElement("option"); option.value = value; option.textContent = label; scenario.append(option);
}
scenario.addEventListener("change", () => {
  const previous = document.querySelector("main"), next = pristinePanel.cloneNode(true); next.style.width = previous.style.width; previous.replaceWith(next);
  current = makeState(scenario.value); panel = createPanel({ connection: "local", name: "Игрок", host: scenario.value !== "player", send }); panel.update(structuredClone(current));
});
document.getElementById("preview-round").addEventListener("click", () => {
  if (!current.combats?.length) return;
  current.elapsed += 3; for (const fight of current.combats) { fight.round++; fight.endsAt += 3; fight.ready = []; }
  panel.update(structuredClone(current));
});
document.getElementById("preview-size").addEventListener("click", event => {
  const compact = document.querySelector("main").style.width !== "320px"; document.querySelector("main").style.width = compact ? "320px" : "340px";
  event.currentTarget.textContent = compact ? "Ширина: 320 → 340" : "Ширина: 340 → 320";
});
current = makeState("lobby"); panel.update(current);
