import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";
import { NS, TOTAL, TEAM_NAME, ACTION_NAMES, COMBAT_ROUNDS } from "./rules.mjs?v=0.3.1";

const element = id => document.getElementById(id);
const key = NS + "/state";
const channel = NS + "/command";
const pointButtons = Array.from(document.querySelectorAll("#points button"));
const combatButtons = Array.from(document.querySelectorAll("#combat button"));
let state;
let connection;
let name;
let host;
let send;
let waiting = false;
let lastLobby = "";
let combatPick = null;
let lastCombat = null;

function timer(seconds) {
  const remaining = Math.ceil(Math.max(0, seconds));
  return Math.floor(remaining / 60) + ":" + String(remaining % 60).padStart(2, "0");
}

function render() {
  element("loading").hidden = Boolean(state);
  element("lobby").hidden = state?.phase !== "lobby";
  element("playing").hidden = !state || state.phase === "lobby";
  if (!state) return;
  const mine = ownSlot();
  const hostControls = host && state.host === connection;

  if (state.phase === "lobby") {
    const claimsKey = JSON.stringify([state.slots, state.claims, waiting]);
    if (claimsKey !== lastLobby) {
      lastLobby = claimsKey;
      for (const team of ["red", "blue"]) {
        const buttons = state.slots.filter(slot => slot.team === team).map(slot => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = slot.name.slice(0, 2);
          const claim = state.claims[slot.id];
          button.title = slot.name + (claim ? " · " + claim.name : "");
          button.setAttribute("aria-label", button.title);
          button.setAttribute("aria-pressed", String(slot.id === mine));
          button.disabled = waiting || Boolean(claim && slot.id !== mine);
          button.addEventListener("click", () => run({
            type: slot.id === mine ? "release" : "claim", id: slot.id, name,
          }));
          return button;
        });
        element(team + "-slots").replaceChildren(...buttons);
      }
    }
    const count = Object.keys(state.claims).length;
    element("count").textContent = count;
    element("picked").textContent = mine ? "Твоя фишка · " + state.slots.find(slot => slot.id === mine).name : "Нажми на свободную фишку своей команды.";
    element("practice").hidden = !hostControls || count !== 0;
    element("practice").disabled = waiting;
    element("start-form").hidden = !hostControls || count === 0;
    element("start").disabled = waiting || count === 0;
    return;
  }

  const finished = state.phase === "finished";
  element("timer").textContent = timer(TOTAL - state.elapsed);
  element("red-score").textContent = state.score.red;
  element("blue-score").textContent = state.score.blue;
  element("winner").textContent = !finished ? "" : state.winner === "draw" ? "Матч завершён · ничья" : "Победа · " + TEAM_NAME[state.winner];
  const pawn = state.pawns[mine];
  const combat = !finished && state.combats?.find(fight => fight.members.includes(mine));
  const canMove = !finished && Boolean(pawn) && !pawn.deadUntil;
  element("practice-opponent").hidden = !state.practice || !hostControls;
  element("practice-opponent").disabled = Boolean(state.practiceOpponent) || waiting || finished;
  element("practice-opponent").textContent = state.practiceOpponent ? "Учебный соперник защищает Каплю" : "Отправить учебного соперника к Капле";
  element("control").textContent = finished ? "" : pawn
    ? combat ? "Идёт бой. Выбирай приём в каждом раунде." : canMove ? "Нажми «Капля», чтобы отправить фишку к центру." : ""
    : "Матч идёт. Сейчас ты зритель.";
  const slotName = pawn && state.slots.find(slot => slot.id === mine).name.slice(0, 2);
  element("me").textContent = !pawn ? "" : pawn.deadUntil
    ? (pawn.deathReason === "inactive" ? "Поражение без действий. " : "") + "Возвращение в бой через " + Math.ceil(pawn.deadUntil - state.elapsed) + " с"
    : pawn.moving && !finished ? slotName + " в пути" : pawn.pet ? "У тебя баф · +2 за каждый сыгранный раунд одного боя" : "Твоя фишка · " + slotName;
  element("combat").hidden = !combat;
  if (combat) {
    const roundKey = combat.id + "/" + combat.round;
    if (combatPick?.key !== roundKey) combatPick = null;
    const ready = combat.ready.includes(mine);
    const chosen = combatPick?.action;
    element("combat-title").textContent = (combat.kind === "pet" ? "Бой за баф · " : "Бой на точке · ") + combat.name;
    element("combat-clock").textContent = "Раунд " + combat.round + "/" + COMBAT_ROUNDS + " · осталось " + Math.max(0, Math.ceil(combat.endsAt - state.elapsed)) + " с";
    element("combat-score").textContent = "Вклад в бой · красные " + combat.totals[0] + " / синие " + combat.totals[1] + (combat.empowered.includes(mine) || pawn.pet ? " · питомец даёт +2 за раунд" : "");
    element("combat-pick").textContent = chosen ? "Выбрано · " + ACTION_NAMES[chosen] + (ready ? ". Жди итог раунда." : ". Отправляю…")
      : ready ? "Приём принят. Жди итог раунда." : "Выбери приём до конца отсчёта.";
    for (const button of combatButtons) {
      button.disabled = ready || Boolean(chosen) || waiting;
      button.setAttribute("aria-pressed", String(button.dataset.action === chosen));
    }
    const previous = combat.previous;
    const result = previous?.results.find(result => result.id === mine);
    element("combat-result").textContent = result
      ? "Прошлый раунд · " + (result.action ? ACTION_NAMES[result.action] + " · d6 " + result.roll + " +2 за действие" + (result.tactic ? " +2 за приём" : "") + (result.pet ? " +2 питомец" : "") + " = " + result.total : "пропуск, вклад 0")
      : "Блок держит удар, обман обходит блок, удар срывает обман. Удачный приём даёт +2.";
    if (lastCombat !== combat.id) {
      lastCombat = combat.id;
      element("combat").scrollIntoView({ block: "start" });
    }
  } else { combatPick = null; lastCombat = null; }
  element("points-heading").textContent = canMove ? "Куда бежать?" : "Точки";
  element("free-move").hidden = !canMove;
  for (const button of pointButtons) {
    const point = state.points.find(point => point.name === button.dataset.point);
    const owner = point.team ? TEAM_NAME[point.team] : "свободна";
    const fight = state.combats?.find(combat => combat.kind === "point" && combat.name === point.name);
    const action = fight ? " · бой, раунд " + fight.round + "/" + COMBAT_ROUNDS
      : point.progress > 0 ? " · захват " + Math.floor(point.progress) + "/10 с" : "";
    button.disabled = !canMove || waiting;
    button.nextElementSibling.textContent = owner + action;
  }
  const ready = state.pets.filter(pet => pet.available && !pet.fighting).map(pet => pet.name);
  const contested = state.pets.filter(pet => pet.fighting).map(pet => pet.name);
  const nextWave = state.nextWave < TOTAL ? " · новая волна через " + timer(state.nextWave - state.elapsed) : "";
  element("pets").textContent = (ready.length ? "Баф доступен · " + ready.join(", ") : "Свободных бафов нет") + (contested.length ? " · бой за " + contested.join(", ") : "") + nextWave;
  const clash = state.lastClash;
  element("clash").textContent = clash
    ? clash.point + " · " + clash.totals.join(" / ") + " · " + TEAM_NAME[clash.winner] + (clash.inactive?.length ? " · без действий проиграли " + clash.inactive.map(id => state.slots.find(slot => slot.id === id)?.name.slice(0, 2)).join(", ") : "")
    : "Бой на точке или месте питомца · 3 раунда по 5 с. Панель откроется при встрече с врагом.";
  element("pace").textContent = (state.calibrated ? "Скорость по замеру" : "Пробный темп") + " · респ → Капля за " + state.routeSeconds + " с";
  element("restart").hidden = !finished || !hostControls;
  element("stop").hidden = finished || !hostControls;
}

function ownSlot() {
  return Object.keys(state.claims).find(slot => state.claims[slot].connection === connection);
}

async function run(data) {
  if (!state || waiting) return;
  waiting = true;
  render();
  try {
    await send({ ...data, board: state.board });
    element("notice").textContent = "";
  } catch (error) {
    console.error(error);
    element("notice").textContent = "Команда не отправилась. Попробуй ещё раз.";
  } finally {
    waiting = false;
    render();
  }
}

element("start-form").addEventListener("submit", event => {
  event.preventDefault();
  const value = element("route").value;
  void run({ type: "start", routeSeconds: value ? Number(value) : null });
});
element("practice").addEventListener("click", () => void run({ type: "start", practice: true }));
element("practice-opponent").addEventListener("click", () => void run({ type: "practice-opponent" }));
for (const button of pointButtons) {
  button.addEventListener("click", () => void run({ type: "move-to-point", id: ownSlot(), point: button.dataset.point }));
}
for (const button of combatButtons) {
  button.addEventListener("click", async () => {
    const mine = ownSlot();
    const combat = state.combats?.find(fight => fight.members.includes(mine));
    if (!combat || combat.ready.includes(mine) || combatPick || waiting) return;
    combatPick = { key: combat.id + "/" + combat.round, action: button.dataset.action };
    render();
    try {
      await send({ type: "combat-action", board: state.board, id: mine, combat: combat.id, round: combat.round, action: button.dataset.action });
    } catch (error) {
      combatPick = null;
      element("notice").textContent = "Приём не отправился. Выбери его ещё раз.";
      console.error(error);
    }
    render();
  });
}
element("restart").addEventListener("click", () => void run({ type: "lobby" }));
element("stop-match").addEventListener("click", () => {
  element("stop").open = false;
  void run({ type: "lobby" });
});

function connect() {
  OBR.onReady(async () => {
    try {
      const [role, metadata] = await Promise.all([
        OBR.player.getRole(), OBR.room.getMetadata(),
        OBR.player.getConnectionId().then(value => { connection = value; }),
        OBR.player.getName().then(value => { name = value; }),
      ]);
      host = role === "GM";
      send = data => OBR.broadcast.sendMessage(channel, data, { destination: "ALL" });
      state = metadata[key];
      OBR.room.onMetadataChange(next => { state = next[key]; render(); });
      element("loading").textContent = "Ведущий должен открыть сцену «Осколок Силы · Пробный матч».";
      render();
    } catch (error) {
      console.error(error);
      element("loading").textContent = "Не удалось подключиться к сцене Owlbear.";
    }
  });
}

if (new URLSearchParams(location.search).has("obrref")) {
  connect();
} else {
  element("loading").textContent = "Открой панель «Доминион» в комнате Owlbear.";
}
