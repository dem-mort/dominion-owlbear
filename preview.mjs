import { createPanel } from "./panel-ui.mjs?v=0.5.4";
const classes = ["Воин", "Храмовник", "Разведчик", "Жрец", "Маг", "Бард"];
const slots = ["К", "С"].flatMap(prefix => classes.map((name, index) => ({ id: prefix + (index + 1), name: prefix + (index + 1) + " · " + name, team: prefix === "К" ? "red" : "blue" })));
const aspects = Object.fromEntries(slots.map(slot => [slot.id, slot.name.endsWith("Жрец") ? "heal" : slot.name.endsWith("Бард") ? "support" : "attack"]));
let current, panel;
const mine = "К4";
const picked = () => ({ [mine]: { connection: "local", name: "Игрок" }, С1: { connection: "other", name: "Александр" } });
function makeState(scenario) {
  const lobby = ["lobby", "selected", "player"].includes(scenario);
  const state = { rules: "0.4.0", board: "preview", host: scenario === "player" ? "other" : "local", slots, aspects: { ...aspects }, claims: scenario === "lobby" ? {} : picked(), phase: lobby ? "lobby" : scenario === "finished" ? "finished" : "playing" };
  if (!lobby) Object.assign(state, { elapsed: 123, score: { red: 380, blue: 420 }, nextWave: 150, routeSeconds: 10, calibrated: false,
    points: [{ name: "Трефа", team: "red" }, { name: "Капля", team: "blue" }, { name: "Звезда", team: null }],
    pets: [{ name: "Б1", available: true }, { name: "Б2", available: false }, { name: "Б3", available: false }],
    pawns: { [mine]: { hp: 76, aspect: "heal", pet: true, moving: scenario === "moving", deadUntil: scenario === "dead" ? 146 : 0, deathReason: "inactive" } }, combats: [] });
  if (["combat", "ready", "missed"].includes(scenario)) state.combats = [{ id: "fight", name: "Капля", kind: "point", round: 2, endsAt: 126, members: [mine, "С1"], numbers: [2, 2],
    counts: [{ attack: 1, support: 0, heal: 1 }, { attack: 1, support: 1, heal: 0 }], ready: scenario === "ready" ? [mine] : [], empowered: [mine],
    previous: { results: [{ id: mine, active: scenario !== "missed", damage: 4, healing: 22, boost: 0 }] } }];
  if (scenario === "spectator") state.claims = { С1: { connection: "other", name: "Александр" } };
  if (scenario === "finished") { state.winner = "blue"; state.score.blue = 1020; state.elapsed = 600; }
  return state;
}
async function send(command) {
  if (command.type === "claim") { for (const [id, claim] of Object.entries(current.claims)) if (claim.connection === "local") delete current.claims[id]; current.claims[command.id] = { connection: "local", name: "Игрок" }; }
  if (command.type === "release") delete current.claims[command.id];
  if (command.type === "set-aspect") current.aspects[command.id] = command.aspect;
  if (command.type === "take-host") current.host = "local";
  if (command.type === "combat-click") current.combats[0].ready.push(command.id);
  if (command.type === "retreat") { current.pawns[mine].retreating = true; current.combats = []; }
  if (command.type === "move-to-point") { current.pawns[mine].moving = true; current.combats = []; }
  if (command.type === "start") { current = makeState("moving"); current.practice = Boolean(command.practice); }
  if (command.type === "lobby") current = makeState("lobby");
  panel.update(structuredClone(current));
}
const pristinePanel = document.querySelector("main").cloneNode(true);
panel = createPanel({ connection: "local", name: "Игрок", host: true, send });
const scenario = document.getElementById("preview-state");
scenario.addEventListener("change", () => {
  const previous = document.querySelector("main"), next = pristinePanel.cloneNode(true);
  next.style.width = previous.style.width;
  previous.replaceWith(next);
  current = makeState(scenario.value);
  panel = createPanel({ connection: "local", name: "Игрок", host: scenario.value !== "player", send });
  panel.update(structuredClone(current));
});
document.getElementById("preview-round").addEventListener("click", () => {
  if (!current.combats?.length) return;
  current.elapsed += 3; current.combats[0].round++; current.combats[0].endsAt += 3; current.combats[0].ready = [];
  panel.update(structuredClone(current));
});
document.getElementById("preview-size").addEventListener("click", event => {
  const compact = document.querySelector("main").style.width !== "320px";
  document.querySelector("main").style.width = compact ? "320px" : "340px";
  event.currentTarget.textContent = compact ? "Ширина: 320 → 340" : "Ширина: 340 → 320";
});
current = makeState("lobby"); panel.update(current);
