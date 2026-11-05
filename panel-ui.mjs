import { TOTAL, TEAM_NAME, ASPECTS, aspectOptions, defaultAspect, COMBAT_STEPS } from "./rules.mjs?v=0.4.0";

const ASPECT_LABEL = { attack: "Нападение", support: "Поддержка", heal: "Исцеление" };
const ACTION_LABEL = { attack: "Атаковать", support: "Поддержать", heal: "Лечить" };
export const timer = seconds => {
  const remaining = Math.ceil(Math.max(0, Number(seconds) || 0));
  return Math.floor(remaining / 60) + ":" + String(remaining % 60).padStart(2, "0");
};
export function panelContext(state, connection, host) {
  const mine = Object.keys(state.claims ?? {}).find(id => state.claims[id].connection === connection);
  const slot = state.slots.find(slot => slot.id === mine);
  return { mine, slot, count: Object.keys(state.claims ?? {}).length, hostControls: host && state.host === connection };
}
export function combatPrompt(combat, pawn, mine, elapsed, pressed) {
  const remaining = Math.max(0, combat.endsAt - elapsed);
  const ready = combat.ready.includes(mine);
  const previous = combat.previous?.results.find(result => result.id === mine);
  if (ready) return { remaining, disabled: true, state: "ready", tone: "success", button: "Действие принято ✓", hint: "Жди следующего сигнала", previous };
  if (pressed) return { remaining, disabled: true, state: "sending", tone: "normal", button: "Отправляю…", hint: "Проверяем действие", previous };
  if (!remaining) return { remaining, disabled: true, state: "waiting", tone: "normal", button: "Следующий сигнал…", hint: "Отсчёт завершён", previous };
  return { remaining, disabled: false, state: "action", tone: previous && !previous.active ? "danger" : "normal",
    button: ACTION_LABEL[pawn.aspect] ?? ACTION_LABEL.attack,
    hint: previous && !previous.active ? "Пропуск 1/2 — действуй сейчас" : "Нажми один раз до конца отсчёта", previous };
}
export function scenePortraits(items) {
  return Object.fromEntries(items.filter(item => item.layer === "CHARACTER").flatMap(item => {
    const image = item.metadata?.["ru.allods.dominion/lobby-position"]?.image ?? item.image;
    return image?.url ? [[item.id, image.url]] : [];
  }));
}
export function displayedCombat(state, pawn, mine) {
  if (state.phase !== "playing" || !pawn || pawn.deadUntil) return undefined;
  return state.combats?.find(fight => fight.members.includes(mine));
}

export function createPanel({ root = document, connection, name, host, send }) {
  const element = id => root.getElementById(id);
  const pointButtons = Array.from(root.querySelectorAll("#points button"));
  const make = (tag, className, value) => {
    const node = root.createElement(tag);
    if (className) node.className = className;
    if (value != null) node.textContent = value;
    return node;
  };
  const text = (id, value) => { const node = element(id); if (node.textContent !== String(value)) node.textContent = value; };
  const notice = value => { text("notice", value); element("notice").hidden = !value; };
  let state, waiting = false, portraits = {}, selectedTeam = "red", lastMine, lastLobby = "", combatPressed = null, lastCombat = null;
  let requestedPoint = null, wasMoving = false;
  const own = () => state && panelContext(state, connection, host).mine;

  function selectTeam(team, focus = false) {
    selectedTeam = team;
    for (const side of ["red", "blue"]) {
      element(side + "-team").hidden = side !== team;
      element("tab-" + side).setAttribute("aria-selected", String(side === team));
      element("tab-" + side).tabIndex = side === team ? 0 : -1;
    }
    if (focus) element("tab-" + team).focus();
  }
  for (const team of ["red", "blue"]) {
    element("tab-" + team).addEventListener("click", () => selectTeam(team));
    element("tab-" + team).addEventListener("keydown", event => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        selectTeam(event.key === "Home" ? "red" : event.key === "End" ? "blue" : team === "red" ? "blue" : "red", true);
      }
    });
  }

  function fillAspectSelect(select, slot) {
    select.replaceChildren(...aspectOptions(slot).map(aspect => {
      const option = make("option", "", ASPECT_LABEL[aspect] + " · " + ASPECTS[aspect].short);
      option.value = aspect;
      return option;
    }));
    select.value = state.aspects?.[slot.id] ?? defaultAspect(slot);
    select.disabled = waiting || aspectOptions(slot).length === 1;
  }

  function renderLobby(context) {
    const { mine, slot: ownSlot, hostControls, count } = context;
    if (mine !== lastMine) { if (ownSlot) selectTeam(ownSlot.team); lastMine = mine; }
    const lobbyKey = JSON.stringify([state.board, state.slots, state.claims, state.aspects, portraits, mine, hostControls]);
    if (lobbyKey !== lastLobby) {
      lastLobby = lobbyKey;
      for (const team of ["red", "blue"]) {
        const slots = state.slots.filter(slot => slot.team === team);
        element(team + "-slots").replaceChildren(...slots.map(slot => {
          const claim = state.claims[slot.id], picked = slot.id === mine;
          const button = make("button", "slot");
          button.type = "button";
          button.dataset.id = slot.id;
          const code = slot.name.slice(0, 2), className = slot.name.split(" · ")[1] ?? slot.name;
          const portrait = make("span", "portrait", className.slice(0, 1));
          if (portraits[slot.id]) {
            const image = make("img");
            image.src = portraits[slot.id]; image.alt = "";
            image.addEventListener("error", () => portrait.replaceChildren(root.createTextNode(className.slice(0, 1))), { once: true });
            portrait.replaceChildren(image);
          }
          button.append(make("span", "slot-code", code), portrait, make("span", "slot-class", className),
            make("span", "slot-status", picked ? "Выбрано ✓" : claim ? claim.name || "Занят" : "Свободен"));
          button.setAttribute("aria-pressed", String(picked));
          button.setAttribute("aria-label", slot.name + (picked ? " · твой персонаж" : claim ? " · занят: " + (claim.name || "игрок") : " · свободен"));
          button.title = slot.name + " · " + ASPECTS[state.aspects?.[slot.id] ?? defaultAspect(slot)].name;
          button.addEventListener("click", () => { if (slot.id !== own()) void run({ type: "claim", id: slot.id, name }); });
          return button;
        }));
        text(team + "-count", slots.filter(slot => state.claims[slot.id]).length + "/6");
      }
      element("selection").dataset.picked = String(Boolean(ownSlot));
      element("own-aspect").hidden = !ownSlot;
      element("release").hidden = !ownSlot;
      text("picked", ownSlot ? ownSlot.name : "Нажми на свободную карточку выше.");
      if (ownSlot) {
        const chosen = state.aspects?.[mine] ?? defaultAspect(ownSlot);
        element("aspect-options").replaceChildren(...aspectOptions(ownSlot).map(aspect => {
          const button = make("button", "", ASPECT_LABEL[aspect]);
          button.type = "button"; button.dataset.aspect = aspect;
          button.setAttribute("aria-pressed", String(aspect === chosen));
          button.setAttribute("aria-label", ASPECTS[aspect].name + " · " + ASPECTS[aspect].short);
          button.addEventListener("click", () => void run({ type: "set-aspect", id: mine, aspect }));
          return button;
        }));
        text("aspect-help", ASPECTS[chosen].short + " · " + ASPECTS[chosen].help);
      }
      element("host-settings").hidden = !hostControls;
      if (hostControls) {
        element("aspect-lineup").replaceChildren(...state.slots.map(slot => {
          const row = make("div", "aspect-row");
          const label = make("label", "", slot.name);
          const select = make("select"); select.id = "aspect-" + slot.id; label.htmlFor = select.id;
          fillAspectSelect(select, slot);
          select.addEventListener("change", () => void run({ type: "set-aspect", id: slot.id, aspect: select.value }));
          row.append(label, select); return row;
        }));
      }
    }
    for (const button of root.querySelectorAll(".slot")) button.disabled = waiting || Boolean(state.claims[button.dataset.id] && button.dataset.id !== mine);
    for (const button of root.querySelectorAll("#aspect-options button")) button.disabled = waiting || button.dataset.aspect === (state.aspects?.[mine] ?? (ownSlot && defaultAspect(ownSlot)));
    for (const select of root.querySelectorAll("#aspect-lineup select")) {
      const slot = state.slots.find(slot => "aspect-" + slot.id === select.id);
      select.disabled = waiting || aspectOptions(slot).length === 1;
    }
    text("count", count);
    element("release").disabled = waiting;
    element("start-form").hidden = !host;
    element("start").disabled = !hostControls || waiting || count === 0;
    element("take-host").hidden = !host || hostControls;
    element("take-host").disabled = waiting;
    element("practice").hidden = !host;
    element("practice").disabled = !hostControls || waiting || count !== 0;
    element("practice").title = count ? "Тренировка доступна, когда все фишки свободны" : "Начать одному за воина К1";
    element("waiting-host").hidden = host;
    text("start-help", host && !hostControls ? "Управление сейчас в другой вкладке ведущего" : hostControls ? count ? count + "/12 игроков готовы · до 1000 очков" : "Для старта нужен хотя бы один персонаж" : ownSlot ? "Ты готов · после старта появишься на респе" : "Выбери персонажа своей команды");
  }

  function renderCombat(combat, pawn, mine) {
    const roundKey = combat.id + "/" + combat.round;
    if (combatPressed?.key !== roundKey) combatPressed = null;
    const prompt = combatPrompt(combat, pawn, mine, state.elapsed, Boolean(combatPressed));
    text("combat-title", (combat.kind === "pet" ? "Баф: " : "Бой: ") + combat.name);
    text("combat-seconds", Math.ceil(prompt.remaining));
    text("combat-clock", prompt.state === "ready" ? "Следующий сигнал" : "Время на действие");
    text("combat-round", combat.round + "/" + COMBAT_STEPS);
    element("combat-progress").value = Math.min(3, prompt.remaining);
    const lineupKey = JSON.stringify([combat.numbers, combat.counts]);
    if (element("combat-lineup").dataset.signature !== lineupKey) {
      element("combat-lineup").dataset.signature = lineupKey;
      element("combat-lineup").replaceChildren(...["red", "blue"].map((team, index) => {
        const box = make("div", "combat-team " + team);
        const title = make("strong", "", TEAM_NAME[team]); title.append(make("b", "", combat.numbers[index]));
        const counts = combat.counts[index];
        box.append(title, make("small", "", "ДД " + counts.attack + " · САП " + counts.support + " · ХИЛ " + counts.heal));
        return box;
      }));
    }
    text("combat-pick", prompt.hint); element("combat-pick").dataset.tone = prompt.tone;
    text("combat-action", prompt.button); element("combat-action").dataset.state = prompt.state;
    element("combat-action").disabled = prompt.disabled || waiting;
    element("retreat").disabled = Boolean(pawn.retreating) || waiting;
    const result = prompt.previous;
    text("combat-result", result ? !result.active ? "Ещё один пропуск подряд — поражение" : "Урон " + result.damage + (result.healing ? " · лечение " + result.healing : "") + (result.boost ? " · ДД +" + result.boost + "%" : "")
      : "Случайность и состав команд решают исход");
    text("combat-score", combat.empowered.includes(mine) || pawn.pet ? "Питомец усиливает твой аспект на 20% в этой стычке." : "Без бафа питомца. Состав команд показан в блоке боя.");
    if (lastCombat !== combat.id) { lastCombat = combat.id; element("play-scroll").scrollTop = 0; }
  }

  function render() {
    const compatible = state?.rules === "0.4.0";
    element("loading").hidden = compatible;
    element("lobby").hidden = !compatible || state.phase !== "lobby";
    element("playing").hidden = !compatible || state.phase === "lobby";
    if (!compatible) {
      if (state) text("loading-help", "Ведущему нужно обновить вкладку Owlbear.");
      return;
    }
    const context = panelContext(state, connection, host);
    const { mine, slot, hostControls } = context;
    text("phase", state.phase === "lobby" ? "Лобби" : state.phase === "finished" ? "Итог" : state.practice ? "Тренировка" : "Матч идёт");
    if (state.phase === "lobby") { requestedPoint = null; wasMoving = false; combatPressed = null; lastCombat = null; renderLobby(context); return; }
    lastLobby = "";
    const finished = state.phase === "finished", pawn = state.pawns[mine];
    const dead = Boolean(pawn?.deadUntil);
    const combat = displayedCombat(state, pawn, mine);
    const canMove = !finished && Boolean(pawn) && !dead;
    const role = ASPECTS[pawn?.aspect ?? "attack"];
    text("timer", timer(TOTAL - state.elapsed)); text("red-score", state.score.red); text("blue-score", state.score.blue);
    element("winner-card").hidden = !finished;
    text("winner", state.winner === "draw" ? "Ничья" : "Победа: " + (TEAM_NAME[state.winner] ?? ""));
    element("restart").hidden = !finished || !hostControls; element("restart").disabled = waiting;
    element("player-card").dataset.dead = String(dead);
    text("me", slot ? slot.name : "Режим зрителя");
    text("player-state", pawn ? dead ? pawn.deathReason === "inactive" ? "Поражение без действий" : "Персонаж погиб" : role.short + " · " + role.help : "Присоединиться можно в следующем матче");
    text("control", finished ? "" : !pawn ? "Наблюдай за точками и счётом" : dead ? "Возрождение через " + Math.max(0, Math.ceil(pawn.deadUntil - state.elapsed)) + " с"
      : pawn.retreating ? "Отступаю к своему респу" : combat ? "Твоё действие — в блоке боя ниже" : pawn.moving ? requestedPoint ? "Бегу: " + requestedPoint : "Персонаж в пути" : "Выбери точку — персонаж побежит сам");
    if (wasMoving && !pawn?.moving) requestedPoint = null;
    wasMoving = Boolean(pawn?.moving);
    element("health-row").hidden = !pawn; element("health").value = pawn?.hp ?? 0; text("health-label", (pawn?.hp ?? 0) + "/100");
    element("pet-charge").hidden = !pawn?.pet && !combat?.empowered?.includes(mine);
    element("combat").hidden = !combat;
    if (combat) renderCombat(combat, pawn, mine); else { combatPressed = null; lastCombat = null; text("combat-score", ""); }
    text("points-heading", canMove ? combat ? "Сменить точку / выйти из боя" : "Куда бежать?" : "Контроль точек");
    text("move-label", canMove ? combat ? "" : "Нажми точку" : dead ? "После респа" : "Обзор");
    element("free-move").hidden = !canMove;
    for (const button of pointButtons) {
      const point = state.points.find(point => point.name === button.dataset.point);
      const fight = state.combats?.find(combat => combat.kind === "point" && combat.name === point.name);
      const status = fight ? "Идёт бой" : point.progress > 0 ? (point.team ? "Снятие " : "Захват ") + Math.ceil(point.progress) + "/10 с" : point.team ? TEAM_NAME[point.team] : "Свободна";
      button.disabled = !canMove || waiting;
      button.dataset.owner = point.team ?? ""; button.dataset.contested = String(Boolean(fight) || point.progress > 0);
      button.querySelector(".point-status").textContent = status;
      button.setAttribute("aria-label", (canMove ? "Бежать: " : "") + point.name + " · " + status);
    }
    const ready = state.pets.filter(pet => pet.available && !pet.fighting).map(pet => pet.name);
    const contested = state.pets.filter(pet => pet.fighting).map(pet => pet.name);
    text("pets", (ready.length ? "Готовы: " + ready.join(", ") : state.nextWave < TOTAL ? "Новая волна через " + timer(state.nextWave - state.elapsed) : "Новых волн не будет") + (contested.length ? " · бой за " + contested.join(", ") : ""));
    const clash = state.lastClash;
    element("clash").hidden = !clash;
    if (clash) text("clash", clash.point + " · " + TEAM_NAME[clash.winner] + (clash.reason === "retreat" ? " · выход с точки" : "") + (clash.inactive?.includes(mine) ? " · поражение без действий" : ""));
    text("pace", (state.calibrated ? "Скорость по замеру" : "Пробный темп") + " · респ → Капля за " + state.routeSeconds + " с");
    element("practice-opponent").hidden = !state.practice || !hostControls;
    element("practice-opponent").disabled = Boolean(state.practiceOpponent) || waiting || finished;
    text("practice-opponent", state.practiceOpponent ? "Соперник направлен к Капле" : "Добавить соперника к Капле");
    element("stop").hidden = finished || !hostControls; element("stop-match").disabled = waiting;
  }

  async function run(data) {
    if (!state || waiting) return;
    waiting = true; render();
    try { await send({ ...data, board: state.board, host: state.host }); notice(""); }
    catch (error) { console.error(error); notice("Команда не отправилась. Попробуй ещё раз."); }
    finally { waiting = false; render(); }
  }
  element("start-form").addEventListener("submit", event => {
    event.preventDefault();
    if (!panelContext(state, connection, host).count) return;
    const value = element("route").value;
    if (!element("route").reportValidity()) return;
    void run({ type: "start", routeSeconds: value ? Number(value) : null });
  });
  element("practice").addEventListener("click", () => void run({ type: "start", practice: true }));
  element("take-host").addEventListener("click", () => void run({ type: "take-host" }));
  element("release").addEventListener("click", () => void run({ type: "release", id: own() }));
  element("practice-opponent").addEventListener("click", () => void run({ type: "practice-opponent" }));
  for (const button of pointButtons) button.addEventListener("click", () => { requestedPoint = button.dataset.point; void run({ type: "move-to-point", id: own(), point: button.dataset.point }); });
  element("combat-action").addEventListener("click", async () => {
    const mine = own(), combat = state?.combats?.find(fight => fight.members.includes(mine));
    if (!combat || combatPrompt(combat, state.pawns[mine], mine, state.elapsed, Boolean(combatPressed)).disabled || waiting) return;
    combatPressed = { key: combat.id + "/" + combat.round }; render();
    try { await send({ type: "combat-click", board: state.board, host: state.host, id: mine, combat: combat.id, round: combat.round }); notice(""); }
    catch (error) { combatPressed = null; notice("Действие не отправилось. Нажми ещё раз."); console.error(error); }
    render();
  });
  element("retreat").addEventListener("click", () => void run({ type: "retreat", id: own() }));
  element("restart").addEventListener("click", () => void run({ type: "lobby" }));
  element("stop-match").addEventListener("click", () => { element("stop").open = false; void run({ type: "lobby" }); });
  return {
    update(next) { const changedBoard = state?.board !== next?.board; state = next; if (changedBoard) { lastLobby = ""; lastMine = null; selectedTeam = "red"; selectTeam("red"); } render(); },
    portraits(next) { if (JSON.stringify(portraits) === JSON.stringify(next)) return; portraits = next; if (state?.phase === "lobby") render(); },
    disconnected(message) { text("loading-help", message); },
  };
}
