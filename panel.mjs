import { NS, TOTAL, TEAM_NAME } from "./rules.mjs";

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
  const canMove = !finished && Boolean(pawn) && !pawn.deadUntil;
  element("control").textContent = finished ? "" : pawn
    ? canMove ? "Нажми «Капля», чтобы отправить фишку к центру." : ""
    : "Матч идёт. Сейчас ты зритель.";
  const slotName = pawn && state.slots.find(slot => slot.id === mine).name.slice(0, 2);
  element("me").textContent = !pawn ? "" : pawn.deadUntil
    ? "Возвращение в бой через " + Math.ceil(pawn.deadUntil - state.elapsed) + " с"
    : pawn.moving && !finished ? slotName + " в пути" : pawn.pet ? "У тебя баф · +2 к ближайшей стычке" : "Твоя фишка · " + slotName;
  element("points-heading").textContent = canMove ? "Куда бежать?" : "Точки";
  element("free-move").hidden = !canMove;
  for (const button of pointButtons) {
    const point = state.points.find(point => point.name === button.dataset.point);
    const owner = point.team ? TEAM_NAME[point.team] : "свободна";
    const action = point.clash > 0 ? " · бросок через " + Math.ceil(15 - point.clash) + " с"
      : point.progress > 0 ? " · захват " + Math.floor(point.progress) + "/10 с" : "";
    button.disabled = !canMove || waiting;
    button.nextElementSibling.textContent = owner + action;
  }
  const ready = state.pets.filter(pet => pet.available).map(pet => pet.name);
  const nextWave = state.nextWave < TOTAL ? " · новая волна через " + timer(state.nextWave - state.elapsed) : "";
  element("pets").textContent = (ready.length ? "Баф доступен · " + ready.join(", ") : "Все бафы на КД") + nextWave;
  const clash = state.lastClash;
  element("clash").textContent = clash
    ? clash.point + " · " + clash.rolls[0] + "+" + clash.bonus[0] + " / " + clash.rolls[1] + "+" + clash.bonus[1] + " · " + TEAM_NAME[clash.winner]
    : "Стычка начинается, когда обе команды входят в один круг.";
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
for (const button of pointButtons) {
  button.addEventListener("click", () => void run({ type: "move-to-point", id: ownSlot(), point: button.dataset.point }));
}
element("restart").addEventListener("click", () => void run({ type: "lobby" }));
element("stop-match").addEventListener("click", () => {
  element("stop").open = false;
  void run({ type: "lobby" });
});

async function connect() {
  const { default: OBR } = await import("https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm");
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
  void connect().catch(error => {
    console.error(error);
    element("loading").textContent = "Не загрузился SDK Owlbear.";
  });
} else {
  element("loading").textContent = "Открой панель «Доминион» в комнате Owlbear.";
}
