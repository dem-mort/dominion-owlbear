import { createPanel } from "./panel-ui.mjs?v=0.11.0";
import { modeOf, ownedIds, claimTargetIds, canStart } from "./control.mjs?v=0.11.0";
import { CLASSES, classId, lineupSlots, aspectOptions, defaultAspect } from "./classes.mjs?v=0.11.0";
import { teamSquads, swapMember } from "./squads.mjs?v=0.11.0";
const classes = ["Воин", "Храмовник", "Разведчик", "Жрец", "Маг", "Бард"];
const slots = ["К", "С"].flatMap(prefix => classes.map((name, index) => ({ id: prefix + (index + 1), name: prefix + (index + 1) + " · " + name, team: prefix === "К" ? "red" : "blue" })));
const aspects = Object.fromEntries(slots.map(slot => [slot.id, slot.name.endsWith("Жрец") ? "heal" : slot.name.endsWith("Бард") ? "support" : "attack"]));
let current, panel;
const mine = "К4";
const picked = () => ({ [mine]: { connection: "local", name: "Игрок" }, С1: { connection: "other", name: "Александр" } });
const ownerClaims = mode => Object.fromEntries(slots.map(slot => [slot.id, { connection: mode === "solo" || slot.team === "red" ? "local" : "other", name: slot.team === "red" || mode === "solo" ? "Игрок" : "Соперник" }]));
function addMatch(state) {
  const fullIndividual = modeOf(state) === "individual" && Object.keys(state.claims).length === 12 && new Set(Object.values(state.claims).map(claim => claim.connection)).size === 12;
  Object.assign(state, { elapsed: 123, score: { red: 380, blue: 420 }, nextWave: 150, routeSeconds: 10, calibrated: false, actionSeconds: fullIndividual && !state.practice ? 1 : 3,
    points: [{ name: "Трефа", team: "red" }, { name: "Капля", team: "blue" }, { name: "Звезда", team: null }],
    pets: [{ name: "Б1", available: true }, { name: "Б2", available: false }, { name: "Б3", available: false }],
    pawns: Object.fromEntries(Object.keys(state.claims).map(id => [id, { hp: 76, aspect: state.aspects[id], pet: id === mine, moving: false, deadUntil: 0 }])), combats: [] });
}
function makeState(scenario) {
  if (["teams-preparing-pairs", "teams-squads-custom"].includes(scenario)) {
    const state = makeState("teams-preparing");
    state.classes = { К2: "summoner", К4: "priest" }; state.slots = lineupSlots(slots, state.classes);
    state.aspects.К2 = "heal"; state.aspects.К4 = "heal"; state.pawns.К2.aspect = "heal";
    if (scenario === "teams-squads-custom") state.squads = { red: swapMember(teamSquads(state, "red"), 0, 1, "К5") };
    state.selections.local = teamSquads(state, "red")[0]; state.active.local = state.selections.local[0]; return state;
  }
  if (scenario.startsWith("class-")) {
    const [id, aspect] = scenario.slice(6).split("--");
    const state = makeState("selected");
    state.classes = { [mine]: id }; state.slots = lineupSlots(slots, state.classes);
    state.aspects[mine] = aspectOptions({ classId: id }).includes(aspect) ? aspect : defaultAspect({ classId: id });
    return state;
  }
  if (scenario === "healer-pairs") {
    const state = makeState("solo-ready");
    state.classes = { К2: "summoner", К4: "priest", С2: "warden", С4: "priest" };
    state.slots = lineupSlots(slots, state.classes);
    for (const id of ["К2", "К4", "С2", "С4"]) state.aspects[id] = "heal";
    state.active.local = "К2"; state.selections.local = ["К2"]; return state;
  }
  if (scenario === "lineup-editor") return makeState("solo-ready");
  const mode = scenario.startsWith("teams") ? "teams" : scenario.startsWith("solo") ? "solo" : "individual";
  const lobby = ["lobby", "selected", "player", "teams-lobby", "teams-ready", "solo-lobby", "solo-ready"].includes(scenario);
  const empty = ["lobby", "teams-lobby", "solo-lobby"].includes(scenario);
  const claims = empty ? {} : mode === "individual" ? picked() : ownerClaims(mode);
  const state = { rules: "0.11.0", board: "preview", host: scenario === "player" ? "other" : "local", slots, aspects: { ...aspects }, controlMode: mode,
    active: empty ? {} : { local: mine }, selections: empty ? {} : { local: [mine] }, claims, phase: lobby ? "lobby" : scenario === "finished" ? "finished" : "playing" };
  if (!lobby) addMatch(state);
  if (scenario.includes("preparing")) {
    state.phase = "preparing"; state.elapsed = 0; state.score = { red: 0, blue: 0 }; state.nextWave = 30;
    state.points.forEach(point => { point.team = null; });
    Object.values(state.pawns).forEach(pawn => { pawn.hp = 100; pawn.pet = false; pawn.atSpawn = true; });
    const required = [...new Set(Object.values(state.claims).map(claim => claim.connection))];
    state.preparation = { remaining: scenario === "preparing-ready" ? 37 : 60, required, ready: scenario === "preparing-ready" ? ["local"] : [] };
    if (scenario === "preparing-spectator") { state.claims = { С1: { connection: "other", name: "Александр" } }; state.preparation.required = ["other"]; }
  }
  if (scenario.endsWith("preparing-planned")) {
    for (const [i, id] of Object.keys(state.claims).filter(id => state.claims[id].connection === "local").entries()) {
      state.pawns[id].planned = true; state.pawns[id].orderPoint = ["Трефа", "Капля", "Звезда"][Math.floor(i / 2) % 3];
    }
    if (mode !== "individual") state.selections.local = slots.filter(slot => state.claims[slot.id]?.connection === "local").map(slot => slot.id);
  }
  if (scenario.includes("respawn")) {
    for (const [i, id] of Object.keys(state.pawns).entries()) {
      state.pawns[id].atSpawn = !scenario.endsWith("partial") || i % 2 === 0;
      if (state.pawns[id].atSpawn) { state.pawns[id].deadUntil = i % 3 ? state.elapsed + 25 - i : 0; state.pawns[id].hp = state.pawns[id].deadUntil ? 0 : 100; }
      state.claims[id].name = ["Александр", "ОченьДлинныйНикнейм", "Тестировщик", "Мария", "Игрок пять", "Шестой"][i % 6];
    }
  }
  if (scenario.endsWith("-recovery")) state.host = "other";
  if (scenario === "moving") state.pawns[mine].moving = true;
  if (scenario === "dead") { state.pawns[mine].deadUntil = 146; state.pawns[mine].deathReason = "inactive"; }
  if (["pet-carrier", "pet-dd"].includes(scenario)) {
    const own = scenario === "pet-dd" ? "К1" : mine;
    state.claims = Object.fromEntries(slots.map(slot => [slot.id, { connection: slot.id === own ? "local" : "player-" + slot.id, name: slot.name }]));
    state.active.local = own; state.selections.local = [own]; addMatch(state);
  }
  const fight = (id, name, members) => {
    const carriers = members.filter(id => state.pawns[id]?.pet);
    const teams = new Set(carriers.map(id => slots.find(slot => slot.id === id)?.team));
    return { id, name, kind: "point", round: 2, endsAt: state.elapsed + state.actionSeconds, stepSeconds: state.actionSeconds, roundLimit: 15 / state.actionSeconds,
      members, numbers: [2, 2], counts: [{ attack: 1, support: 0, heal: 1 }, { attack: 1, support: 1, heal: 0 }], ready: [], carriers,
      empowered: members.filter(id => state.pawns[id]?.aspect === "attack" && teams.has(slots.find(slot => slot.id === id)?.team)), previous: null };
  };
  if (["combat", "ready", "missed"].includes(scenario)) {
    state.combats = [fight("fight", "Капля", [mine, "С1"])];
    state.combats[0].ready = scenario === "ready" ? [mine] : [];
    state.combats[0].previous = { results: [{ id: mine, active: scenario !== "missed", damage: 4, healing: 22, boost: 0 }] };
  }
  if (scenario.endsWith("-combats")) state.combats = [fight("fight-A", "Капля", ["К1", "К2", "С1", "С2"]), fight("fight-B", "Звезда", ["К3", "К4", "С3", "С4"])];
  if (scenario === "teams-three-combats") { state.combats.push(fight("fight-C", "Трефа", ["К5", "К6", "С5", "С6"])); state.combats[0].ready = ["К1", "К2"]; }
  if (scenario.startsWith("teams-capture-")) {
    const paused = scenario.endsWith("paused"), rollback = scenario.endsWith("rollback");
    const point = state.points.find(point => point.name === "Капля");
    Object.assign(point, { team: rollback ? "blue" : null, capturing: "red", progress: 42, captureRate: paused ? 0 : (rollback ? -1 : 1) * 100 / 30 });
    const members = rollback ? [mine, "С1", "С2", "С3"] : paused ? ["К1", mine, "С1"] : ["К1", "К2", mine, "С1"];
    state.combats = [fight("capture-fight", "Капля", members)];
    state.combats[0].numbers = rollback ? [1, 3] : paused ? [2, 1] : [3, 1];
    state.combats[0].counts = [{ attack: rollback ? 0 : paused ? 1 : 2, support: 0, heal: 1 }, { attack: rollback ? 3 : 1, support: 0, heal: 0 }];
  }
  if (["pet-carrier", "pet-dd", "teams-pet-aura"].includes(scenario)) {
    state.pawns.К1 = { hp: 76, aspect: "attack", pet: false, moving: false, deadUntil: 0 };
    state.pawns[mine].pet = false;
    state.combats = [fight("pet-aura", "Капля", ["К1", mine, "С1"])];
    Object.assign(state.combats[0], { carriers: [mine], empowered: ["К1"], numbers: [2, 1], counts: [{ attack: 1, support: 0, heal: 1 }, { attack: 1, support: 0, heal: 0 }] });
    if (scenario === "pet-dd") { state.active.local = "К1"; state.selections.local = ["К1"]; }
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
  if (command.type === "set-squads") { current.squads ??= {}; current.squads[command.team] = command.groups; }
  if (command.type === "set-aspect") current.aspects[command.id] = command.aspect;
  if (command.type === "set-class" && Object.hasOwn(CLASSES, command.classId)) {
    current.classes ??= {}; current.classes[command.id] = command.classId;
    current.slots = lineupSlots(slots, current.classes);
    const slot = current.slots.find(s => s.id === command.id);
    if (!aspectOptions(slot).includes(current.aspects[command.id])) current.aspects[command.id] = defaultAspect(slot);
  }
  if (command.type === "take-host") current.host = "local";
  if (command.type === "combat-click") {
    const fight = current.combats.find(fight => fight.id === command.combat);
    for (const id of fight.members.filter(id => current.claims[id]?.connection === "local")) if (!fight.ready.includes(id)) fight.ready.push(id);
  }
  if (command.type === "focus-combat") document.getElementById("preview-round").textContent = "Демо: цель находится в комнате Owlbear";
  if (command.type === "retreat") { for (const id of command.ids) current.pawns[id].retreating = true; current.combats = current.combats.filter(fight => !command.ids.some(id => fight.members.includes(id))); }
  if (command.type === "move-to-point") for (const id of command.ids) Object.assign(current.pawns[id], { moving: current.phase !== "preparing", planned: current.phase === "preparing", orderPoint: command.point });
  if (command.type === "stop") for (const id of command.ids) Object.assign(current.pawns[id], { moving: false, planned: false, orderPoint: null });
  if (command.type === "start") {
    if (command.practice) { current.claims = { К1: { connection: "local", name: "К1" } }; current.active.local = "К1"; current.selections.local = ["К1"]; }
    else if (!canStart(current)) return;
    current.phase = command.practice ? "playing" : "preparing"; current.practice = Boolean(command.practice); addMatch(current);
    if (!command.practice) {
      current.elapsed = 0; current.score = { red: 0, blue: 0 }; current.nextWave = 30;
      current.points.forEach(point => { point.team = null; });
      Object.values(current.pawns).forEach(pawn => { pawn.hp = 100; pawn.pet = false; pawn.atSpawn = true; });
      current.preparation = { remaining: 60, required: [...new Set(Object.values(current.claims).map(claim => claim.connection))], ready: [] };
    }
  }
  if (command.type === "ready-early" && current.phase === "preparing" && current.preparation.required.includes("local")) {
    if (!current.preparation.ready.includes("local")) current.preparation.ready.push("local");
    if (current.preparation.required.every(id => current.preparation.ready.includes(id))) { current.phase = "playing"; delete current.preparation; for (const pawn of Object.values(current.pawns)) { pawn.moving = Boolean(pawn.planned); pawn.planned = false; } }
  }
  if (["lobby", "recover-lobby"].includes(command.type)) { current.phase = "lobby"; current.combats = []; current.host = "local"; delete current.preparation; }
  panel.update(structuredClone(current));
}
const pristinePanel = document.querySelector("main").cloneNode(true);
panel = createPanel({ connection: "local", name: "Игрок", host: true, send });
const scenario = document.getElementById("preview-state");
const addPreviewOption = (value, label) => {
  if (Array.from(scenario.options).some(option => option.value === value)) return;
  const option = document.createElement("option"); option.value = value; option.textContent = label; scenario.append(option);
};
for (const [value, label] of [["preparing", "Подготовка · 1:00"], ["preparing-ready", "Подготовка · ты готов"], ["preparing-spectator", "Подготовка · ведущий без фишки"], ["preparing-recovery", "Подготовка · другой ведущий"], ["solo-preparing", "Подготовка · один за 12"], ["teams-preparing", "Подготовка · две команды"], ["playing-recovery", "Матч · другой ведущий"], ["finished-recovery", "Итог · другой ведущий"]]) {
  addPreviewOption(value, label);
}
for (const [value, label] of [["teams-capture-contested", "Захват · перевес 3:1"], ["teams-capture-paused", "Захват · пауза 2:1"], ["teams-capture-rollback", "Захват · откат 1:3"]]) {
  addPreviewOption(value, label);
}
for (const [value, label] of [["pet-carrier", "1 с · носитель-лекарь"], ["pet-dd", "1 с · усиленный ДД"], ["teams-pet-aura", "3 с · баф от лекаря своим ДД"]]) addPreviewOption(value, label);
for (const [id, info] of Object.entries(CLASSES)) for (const aspect of info.aspects) addPreviewOption("class-" + id + "--" + aspect, "Класс: " + info.name + " · " + aspect);
addPreviewOption("healer-pairs", "Состав: две пары ДД + хил");
addPreviewOption("lineup-editor", "Настройки: классы всех 12");
addPreviewOption("preparing-planned", "Приказ на старт · персонаж");
addPreviewOption("teams-preparing-planned", "Приказ на старт · команда");
addPreviewOption("solo-preparing-planned", "Приказ на старт · все 12");
addPreviewOption("teams-respawn", "Респ · шесть союзников");
addPreviewOption("teams-respawn-partial", "Респ · часть команды");
addPreviewOption("solo-respawn", "Респ · обе команды");
addPreviewOption("teams-preparing-pairs", "Подготовка · две пары с хилами");
addPreviewOption("teams-squads-custom", "Подготовка · свои группы");
addPreviewOption("teams-three-combats", "Три стычки · одно действие принято");
scenario.addEventListener("change", () => {
  const previous = document.querySelector("main"), next = pristinePanel.cloneNode(true); next.style.width = previous.style.width; previous.replaceWith(next);
  current = makeState(scenario.value); panel = createPanel({ connection: "local", name: "Игрок", host: scenario.value !== "player", send }); panel.update(structuredClone(current));
});
document.getElementById("preview-round").addEventListener("click", () => {
  if (!current.combats?.length) return;
  current.elapsed += current.actionSeconds ?? 3; for (const fight of current.combats) { fight.round = fight.round % (fight.roundLimit ?? 5) + 1; fight.endsAt += fight.stepSeconds ?? 3; fight.ready = []; }
  panel.update(structuredClone(current));
});
document.getElementById("preview-size").addEventListener("click", event => {
  const compact = document.querySelector("main").style.width !== "320px"; document.querySelector("main").style.width = compact ? "320px" : "340px";
  event.currentTarget.textContent = compact ? "Ширина: 320 → 340" : "Ширина: 340 → 320";
});
current = makeState("lobby"); panel.update(current);
