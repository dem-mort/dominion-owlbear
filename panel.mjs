import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";
import { NS, TOTAL, TEAM_NAME, ASPECTS, aspectOptions, defaultAspect, COMBAT_STEPS } from "./rules.mjs?v=0.4.0";

const element = id => document.getElementById(id);
const key = NS + "/state";
const channel = NS + "/command";
const pointButtons = Array.from(document.querySelectorAll("#points button"));
let state;
let connection;
let name;
let host;
let send;
let waiting = false;
let lastLobby = "";
let combatPressed = null;
let lastCombat = null;

function timer(seconds) {
  const remaining = Math.ceil(Math.max(0, seconds));
  return Math.floor(remaining / 60) + ":" + String(remaining % 60).padStart(2, "0");
}

function fillAspectSelect(select, slot) {
  const allowed = aspectOptions(slot);
  select.replaceChildren(...allowed.map(aspect => {
    const option = document.createElement("option");
    option.value = aspect;
    option.textContent = ASPECTS[aspect].name + " · " + ASPECTS[aspect].short;
    return option;
  }));
  select.value = state.aspects?.[slot.id] ?? defaultAspect(slot);
  select.disabled = waiting || allowed.length === 1;
}

function render() {
  const compatible = state?.rules === "0.4.0";
  element("loading").hidden = compatible;
  element("lobby").hidden = !compatible || state?.phase !== "lobby";
  element("playing").hidden = !compatible || state.phase === "lobby";
  if (!state) return;
  if (!compatible) { element("loading").textContent = "Ведущему нужно обновить вкладку Owlbear для новой механики боя."; return; }
  const mine = ownSlot();
  const hostControls = host && state.host === connection;

  if (state.phase === "lobby") {
    const claimsKey = JSON.stringify([state.slots, state.claims, state.aspects, waiting]);
    if (claimsKey !== lastLobby) {
      lastLobby = claimsKey;
      for (const team of ["red", "blue"]) {
        const buttons = state.slots.filter(slot => slot.team === team).map(slot => {
          const button = document.createElement("button");
          button.type = "button";
          const aspect = state.aspects?.[slot.id] ?? defaultAspect(slot);
          button.textContent = slot.name.slice(0, 2) + " · " + ASPECTS[aspect].short;
          const claim = state.claims[slot.id];
          button.title = slot.name + " · " + ASPECTS[aspect].name + (claim ? " · " + claim.name : "");
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
      const own = state.slots.find(slot => slot.id === mine);
      element("own-aspect").hidden = !own;
      if (own) {
        fillAspectSelect(element("aspect"), own);
        element("aspect-help").textContent = ASPECTS[state.aspects?.[mine] ?? defaultAspect(own)].help;
      }
      element("team-aspects").hidden = !hostControls;
      if (hostControls) {
        element("aspect-lineup").replaceChildren(...state.slots.map(slot => {
          const row = document.createElement("div");
          row.className = "aspect-row";
          const label = document.createElement("label");
          label.textContent = slot.name;
          const select = document.createElement("select");
          select.id = "aspect-" + slot.id;
          label.htmlFor = select.id;
          fillAspectSelect(select, slot);
          select.addEventListener("change", () => void run({ type: "set-aspect", id: slot.id, aspect: select.value }));
          row.append(label, select);
          return row;
        }));
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
  const role = ASPECTS[pawn?.aspect ?? "attack"];
  element("practice-opponent").hidden = !state.practice || !hostControls;
  element("practice-opponent").disabled = Boolean(state.practiceOpponent) || waiting || finished;
  element("practice-opponent").textContent = state.practiceOpponent ? "Учебный соперник защищает Каплю" : "Отправить учебного соперника к Капле";
  element("control").textContent = finished ? "" : pawn
    ? combat ? "Идёт бой. Нажимай большую кнопку каждые 3 секунды." : canMove ? "Нажми точку, чтобы отправить туда фишку." : ""
    : "Матч идёт. Сейчас ты зритель.";
  const slotName = pawn && state.slots.find(slot => slot.id === mine).name.slice(0, 2);
  element("me").textContent = !pawn ? "" : pawn.deadUntil
    ? (pawn.deathReason === "inactive" ? "Поражение без действий. " : "") + "Возвращение в бой через " + Math.ceil(pawn.deadUntil - state.elapsed) + " с"
    : slotName + " · " + role.short + " · здоровье " + (pawn.hp ?? 100) + "/100" + (pawn.retreating ? " · отступаю" : pawn.moving && !finished ? " · в пути" : "") + (pawn.pet ? " · питомец готов" : "");
  element("health").hidden = !pawn;
  element("health").value = pawn?.hp ?? 0;
  element("combat").hidden = !combat;
  if (combat) {
    const roundKey = combat.id + "/" + combat.round;
    if (combatPressed?.key !== roundKey) combatPressed = null;
    const ready = combat.ready.includes(mine);
    element("combat-title").textContent = (combat.kind === "pet" ? "Бой за баф · " : "Бой на точке · ") + combat.name;
    element("combat-clock").textContent = "Действие " + combat.round + "/" + COMBAT_STEPS + " · осталось " + Math.max(0, Math.ceil(combat.endsAt - state.elapsed)) + " с";
    element("combat-score").textContent = "На точке · красные " + combat.numbers[0] + " / синие " + combat.numbers[1] + (combat.empowered.includes(mine) || pawn.pet ? " · питомец усиливает аспект на 20%" : "");
    element("combat-lineup").textContent = combat.counts.map((counts, index) => TEAM_NAME[index === 0 ? "red" : "blue"] + " · ДД " + counts.attack + ", САП " + counts.support + ", ХИЛ " + counts.heal).join(" / ");
    element("combat-pick").textContent = ready ? "Действие принято. Жди следующего сигнала."
      : combatPressed ? "Отправляю действие…" : "Нажми один раз до конца отсчёта.";
    element("combat-action").textContent = ready || combatPressed ? "Готово · жди сигнала" : pawn.aspect === "heal" ? "Лечить" : pawn.aspect === "support" ? "Поддержать" : "Атаковать";
    element("combat-action").disabled = ready || Boolean(combatPressed) || waiting;
    element("retreat").disabled = Boolean(pawn.retreating) || waiting;
    const previous = combat.previous;
    const result = previous?.results.find(result => result.id === mine);
    element("combat-result").textContent = result
      ? result.active ? "Прошлое действие · урон " + result.damage + (result.healing ? " · лечение " + result.healing : "") + (result.boost ? " · усиление ДД " + result.boost + "%" : "")
        : "Пропуск. Ещё один подряд приведёт к поражению."
      : role.help + ". Случайность, состав и здоровье определяют исход боя.";
    if (lastCombat !== combat.id) {
      lastCombat = combat.id;
      element("combat").scrollIntoView({ block: "start" });
    }
  } else { combatPressed = null; lastCombat = null; }
  element("points-heading").textContent = canMove ? "Куда бежать?" : "Точки";
  element("free-move").hidden = !canMove;
  for (const button of pointButtons) {
    const point = state.points.find(point => point.name === button.dataset.point);
    const owner = point.team ? TEAM_NAME[point.team] : "свободна";
    const fight = state.combats?.find(combat => combat.kind === "point" && combat.name === point.name);
    const action = fight ? " · бой, действие " + fight.round + "/" + COMBAT_STEPS
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
    ? clash.point + " · " + TEAM_NAME[clash.winner] + (clash.reason === "retreat" ? " · враг ушёл с точки" : "") + (clash.inactive?.length ? " · без действий проиграли " + clash.inactive.map(id => state.slots.find(slot => slot.id === id)?.name.slice(0, 2)).join(", ") : "")
    : "При встрече с врагом откроется бой. Клики поддерживают активность, исход зависит от случайности и состава.";
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
element("aspect").addEventListener("change", () => void run({ type: "set-aspect", id: ownSlot(), aspect: element("aspect").value }));
for (const button of pointButtons) {
  button.addEventListener("click", () => void run({ type: "move-to-point", id: ownSlot(), point: button.dataset.point }));
}
element("combat-action").addEventListener("click", async () => {
    const mine = ownSlot();
    const combat = state.combats?.find(fight => fight.members.includes(mine));
    if (!combat || combat.ready.includes(mine) || combatPressed || waiting) return;
    combatPressed = { key: combat.id + "/" + combat.round };
    render();
    try {
      await send({ type: "combat-click", board: state.board, id: mine, combat: combat.id, round: combat.round });
      element("notice").textContent = "";
    } catch (error) {
      combatPressed = null;
      element("notice").textContent = "Действие не отправилось. Нажми ещё раз.";
      console.error(error);
    }
    render();
});
element("retreat").addEventListener("click", () => void run({ type: "retreat", id: ownSlot() }));
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
