import { TOTAL, TEAM_NAME, ASPECTS, aspectOptions, defaultAspect, captureStatus } from "./rules.mjs?v=0.8.2";
import { CONTROL_MODES, modeOf, ownedIds, activeId, selectedIds, claimTargetIds, canStart } from "./control.mjs?v=0.8.2";
import { isOlderSnapshot } from "./snapshot-sync.mjs?v=0.8.2";

const ASPECT_LABEL = { attack: "Нападение", support: "Поддержка", heal: "Исцеление" };
const ACTION_LABEL = { attack: "Атаковать", support: "Поддержать", heal: "Лечить" };
export const timer = seconds => {
  const remaining = Math.ceil(Math.max(0, Number(seconds) || 0));
  return Math.floor(remaining / 60) + ":" + String(remaining % 60).padStart(2, "0");
};
export function panelContext(state, connection, host) {
  const mine = activeId(state, connection);
  const slot = state.slots.find(slot => slot.id === mine);
  return { mine, slot, count: Object.keys(state.claims ?? {}).length, hostControls: host && state.host === connection };
}
export function preparationPrompt(state, connection) {
  if (state?.phase !== "preparing") return null;
  const preparation = state.preparation ?? {};
  const required = [...new Set(preparation.required ?? [])];
  const ready = new Set((preparation.ready ?? []).filter(id => required.includes(id)));
  const eligible = required.includes(connection) && ownedIds(state, connection).length > 0;
  return { remaining: timer(preparation.remaining), readyCount: ready.size, requiredCount: required.length,
    eligible, ready: eligible && ready.has(connection), disabled: !eligible || ready.has(connection),
    button: ready.has(connection) && eligible ? "Ты готов ✓" : "Начать раньше" };
}
export function combatPrompt(combat, pawn, mine, elapsed, pressed) {
  const remaining = Math.max(0, combat.endsAt - elapsed);
  const stepSeconds = combat.stepSeconds === 1 ? 1 : 3, roundLimit = combat.roundLimit ?? 5;
  const finish = prompt => stepSeconds === 1
    ? { ...prompt, stepSeconds, roundLimit, mapTarget: true, disabled: true, button: "Нажми цель на карте", hint: prompt.state === "ready" ? "Действие принято ✓ · жди следующую цель" : "Цель меняется каждую секунду" }
    : { ...prompt, stepSeconds, roundLimit, mapTarget: false };
  const ready = combat.ready.includes(mine);
  const previous = combat.previous?.results.find(result => result.id === mine);
  if (ready) return finish({ remaining, disabled: true, state: "ready", tone: "success", button: "Действие принято ✓", hint: "Жди следующего сигнала", previous });
  if (pressed) return finish({ remaining, disabled: true, state: "sending", tone: "normal", button: "Отправляю…", hint: "Проверяем действие", previous });
  if (!remaining) return finish({ remaining, disabled: true, state: "waiting", tone: "normal", button: "Следующий сигнал…", hint: "Отсчёт завершён", previous });
  return finish({ remaining, disabled: false, state: "action", tone: previous && !previous.active ? "danger" : "normal",
    button: ACTION_LABEL[pawn.aspect] ?? ACTION_LABEL.attack,
    hint: previous && !previous.active ? "Пропуск 1/2 — действуй сейчас" : "Нажми один раз до конца отсчёта", previous });
}
export function petAuraPrompt(pawn, combat, id) {
  const carrier = Boolean(combat?.carriers?.includes(id));
  const empowered = pawn?.aspect === "attack" && Boolean(combat?.empowered?.includes(id));
  const charged = Boolean(pawn?.pet);
  const help = empowered ? "Твой урон усилен на 30%. Бафы питомцев не складываются."
    : carrier ? "Ты носитель: +30% к урону ДД своей команды в этой стычке. " + (pawn?.aspect === "heal" ? "Твоё лечение не усиливается." : pawn?.aspect === "support" ? "Твоя поддержка не усиливается." : "Бафы не складываются.")
    : charged ? "Заряд: +30% к урону ДД в одной стычке. Бафы не складываются." : "";
  return { carrier, empowered, charged, visible: carrier || empowered || charged, label: "+30% к урону ДД", help };
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
export function controllerCombats(state, connection) {
  if (state?.phase !== "playing") return [];
  const mine = new Set(ownedIds(state, connection).filter(id => state.pawns?.[id] && !state.pawns[id].deadUntil));
  return (state.combats ?? []).filter(fight => fight.members.some(id => mine.has(id)));
}
export function controllerCombatPrompt(state, combat, connection, pressed) {
  const ids = combat.members.filter(id => state.claims[id]?.connection === connection && state.pawns[id] && !state.pawns[id].deadUntil);
  if (!ids.length) return null;
  const readyCount = ids.filter(id => combat.ready.includes(id)).length;
  const ready = readyCount === ids.length;
  const prompt = combatPrompt({ ...combat, ready: ready ? [ids[0]] : [] }, state.pawns[ids[0]], ids[0], state.elapsed, pressed);
  const results = combat.previous?.results.filter(result => ids.includes(result.id)) ?? [];
  const missed = results.filter(result => !result.active).length;
  if (ids.length > 1) {
    if (prompt.state === "action" && !prompt.mapTarget) prompt.button = "Действовать за " + ids.length;
    if (prompt.state === "ready" && !prompt.mapTarget) prompt.button = "Действия приняты ✓";
    if (missed && !ready && !pressed && !prompt.mapTarget) { prompt.hint = "Пропуск у " + missed + " · ещё один — поражение"; prompt.tone = "danger"; }
  }
  return { ...prompt, ids, readyCount, missed, results };
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
  let state, waiting = false, portraits = {}, selectedTeam = "red", lastMine, lastLobby = "", lastCombat = null, focusedCombatId = null;
  const combatPressed = new Set();
  let requestedPoint = null, wasMoving = false, lastSelectionKey = "";
  const own = () => state && panelContext(state, connection, host).mine;
  const myFights = () => controllerCombats(state, connection);
  const focusedFight = () => {
    const fights = myFights();
    const fight = fights.find(fight => fight.id === focusedCombatId) ?? fights.find(fight => fight.members.includes(own())) ?? fights[0];
    focusedCombatId = fight?.id ?? null;
    return fight;
  };

  function selectTeam(team, focus = false) {
    selectedTeam = team;
    for (const side of ["red", "blue"]) {
      element(side + "-team").hidden = side !== team;
      element("tab-" + side).setAttribute("aria-selected", String(side === team));
      element("tab-" + side).tabIndex = side === team ? 0 : -1;
    }
    if (focus) element("tab-" + team).focus();
    if (state?.phase === "lobby") renderGroupClaim();
  }

  function renderGroupClaim() {
    const mode = modeOf(state), targets = claimTargetIds(state, { team: selectedTeam });
    element("claim-group").hidden = mode === "individual";
    if (mode === "individual") return;
    const allMine = targets.every(id => state.claims[id]?.connection === connection);
    const blocked = targets.some(id => state.claims[id] && state.claims[id].connection !== connection);
    text("claim-group", blocked ? mode === "solo" ? "Все персонажи уже заняты" : "Команда уже занята" : allMine ? mode === "solo" ? "Все 12 твои ✓" : "Команда твоя ✓" : mode === "solo" ? "Взять всех 12 персонажей" : "Взять " + (selectedTeam === "red" ? "красных" : "синих") + " · 6 персонажей");
    element("claim-group").disabled = waiting || blocked || allMine;
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
    const mode = modeOf(state), multi = mode !== "individual";
    const lobbyKey = JSON.stringify([state.board, state.slots, state.claims, state.aspects, portraits, mine, hostControls, mode]);
    if (lobbyKey !== lastLobby) {
      lastLobby = lobbyKey;
      for (const team of ["red", "blue"]) {
        const slots = state.slots.filter(slot => slot.team === team);
        element(team + "-slots").replaceChildren(...slots.map(slot => {
          const claim = state.claims[slot.id], picked = slot.id === mine, owned = claim?.connection === connection;
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
            make("span", "slot-status", picked ? "Выбрано ✓" : owned ? "Твой · " + ASPECTS[state.aspects?.[slot.id] ?? defaultAspect(slot)].short : claim ? claim.name || "Занят" : "Свободен"));
          button.setAttribute("aria-pressed", String(picked));
          button.setAttribute("aria-label", slot.name + (owned ? " · твой персонаж" : claim ? " · занят: " + (claim.name || "игрок") : " · свободен"));
          button.title = slot.name + " · " + ASPECTS[state.aspects?.[slot.id] ?? defaultAspect(slot)].name;
          button.addEventListener("click", () => {
            if (slot.id === own()) return;
            void run(owned ? { type: "select-pawns", id: slot.id, ids: [slot.id] } : { type: "claim", id: slot.id, team: slot.team, name });
          });
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
    for (const button of root.querySelectorAll(".slot")) button.disabled = waiting || Boolean(state.claims[button.dataset.id] && state.claims[button.dataset.id].connection !== connection);
    for (const button of root.querySelectorAll("#aspect-options button")) button.disabled = waiting || button.dataset.aspect === (state.aspects?.[mine] ?? (ownSlot && defaultAspect(ownSlot)));
    for (const select of root.querySelectorAll("#aspect-lineup select")) {
      const slot = state.slots.find(slot => "aspect-" + slot.id === select.id);
      select.disabled = waiting || aspectOptions(slot).length === 1;
    }
    text("count", count);
    text("lobby-title", multi ? mode === "teams" ? "Выбери команду" : "Тест за всех 12" : "Выбери персонажа");
    element("control-mode").value = mode;
    element("control-mode").disabled = !hostControls || waiting;
    text("mode-help", hostControls ? "Карта 6×6 · смена режима освобождает фишки" : "Карта 6×6 · режим выбирает ведущий");
    renderGroupClaim();
    text("release", mode === "teams" ? "Освободить команду" : mode === "solo" ? "Освободить всех 12" : "Освободить фишку");
    element("release").disabled = waiting;
    element("start-form").hidden = !host;
    element("start").disabled = !hostControls || waiting || !canStart(state);
    element("take-host").hidden = !host || hostControls;
    element("take-host").disabled = waiting;
    element("practice").hidden = !host || multi;
    element("practice").disabled = !hostControls || waiting || count !== 0;
    element("practice").title = count ? "Тренировка доступна, когда все фишки свободны" : "Начать одному за воина К1";
    element("waiting-host").hidden = host;
    const people = new Set(Object.values(state.claims).map(claim => claim.connection)).size;
    const preparation = multi ? canStart(state) ? people + "/" + CONTROL_MODES[mode].controllers + " игроков · 12 персонажей готовы" : mode === "teams" ? "Нужны 2 игрока: по одному на команду" : "Возьми всех 12 персонажей для теста" : count ? count + "/12 игроков готовы · до 1000 очков" : "Для старта нужен хотя бы один персонаж";
    text("start-help", host && !hostControls ? "Управление сейчас в другой вкладке ведущего" : hostControls ? preparation : ownSlot ? "Ты готов · после старта появишься на респе" : multi ? "Выбери команду своей кнопкой" : "Выбери персонажа своей команды");
  }

  function renderMultiControls(context) {
    const ids = ownedIds(state, connection), chosen = selectedIds(state, connection), mode = modeOf(state);
    element("multi-controls").hidden = mode === "individual" || !ids.length;
    if (mode === "individual" || !ids.length) return;
    text("owned-count", ids.length + " своих");
    const picker = element("active-pawn"), scope = element("move-scope"), signature = ids.join("/");
    if (picker.dataset.signature !== signature) {
      picker.dataset.signature = signature;
      picker.replaceChildren(...ids.map(id => { const option = make("option"); option.value = id; return option; }));
    }
    if (root.activeElement !== picker) for (const option of picker.options) {
      const slot = state.slots.find(slot => slot.id === option.value), pawn = state.pawns[slot.id];
      option.textContent = slot.name + (pawn?.deadUntil ? " · респ " + Math.max(0, Math.ceil(pawn.deadUntil - state.elapsed)) + " с" : " · " + (pawn?.hp ?? 100) + " HP");
    }
    picker.value = context.mine;
    picker.disabled = waiting || state.phase === "finished";
    const groups = [{ value: "single", text: "Только выбранный", ids: [context.mine] }];
    if (mode === "solo") for (const team of ["red", "blue"]) groups.push({ value: team, text: "Все " + (team === "red" ? "красные" : "синие") + " · 6", ids: ids.filter(id => state.slots.find(slot => slot.id === id).team === team) });
    groups.push({ value: "all", text: mode === "solo" ? "Все 12 персонажей" : "Вся команда · 6", ids });
    const current = groups.find(group => group.ids.length === chosen.length && group.ids.every(id => chosen.includes(id)))?.value ?? "custom";
    const scopeKey = JSON.stringify(groups.map(group => [group.value, group.text]));
    if (scope.dataset.signature !== scopeKey) {
      scope.dataset.signature = scopeKey;
      scope.replaceChildren(...groups.map(group => { const option = make("option", "", group.text); option.value = group.value; return option; }));
    }
    if (current === "custom" && !scope.querySelector('option[value="custom"]')) { const option = make("option", "", "Группа · " + chosen.length); option.value = "custom"; option.disabled = true; scope.append(option); }
    scope.value = current; scope.disabled = waiting || state.phase !== "playing";
    const alive = chosen.filter(id => state.pawns[id] && !state.pawns[id].deadUntil).length;
    text("selection-summary", state.phase === "preparing" ? "Можно посмотреть своих персонажей. Движение откроется после подготовки." : "Приказ для " + chosen.length + " · в строю " + alive + ". «Бег» на карте управляет тем же выбором.");
  }

  function renderFightTabs(fights, focused) {
    element("fight-tabs").hidden = fights.length < 2;
    if (fights.length < 2) return;
    const signature = JSON.stringify([focused?.id, fights.map(fight => [fight.id, fight.round, fight.members, fight.ready])]);
    if (element("fight-tabs").dataset.signature === signature) return;
    element("fight-tabs").dataset.signature = signature;
    element("fight-tabs").replaceChildren(...fights.map(fight => {
      const own = fight.members.filter(id => state.claims[id]?.connection === connection), ready = own.filter(id => fight.ready.includes(id)).length;
      const button = make("button", "", fight.name + " · " + ready + "/" + own.length + " готовы");
      button.type = "button"; button.dataset.needsAction = String(ready < own.length);
      button.setAttribute("aria-pressed", String(fight.id === focused?.id));
      button.addEventListener("click", () => { focusedCombatId = fight.id; render(); });
      return button;
    }));
  }

  function renderCombat(combat) {
    const roundKey = combat.id + "/" + combat.round;
    const prompt = controllerCombatPrompt(state, combat, connection, combatPressed.has(roundKey));
    if (!prompt) return;
    const members = prompt.ids, pawn = state.pawns[members[0]], mine = members[0];
    text("combat-title", (combat.kind === "pet" ? "Баф: " : "Бой: ") + combat.name);
    text("combat-seconds", Math.ceil(prompt.remaining));
    text("combat-clock", prompt.state === "ready" ? "Следующий сигнал" : "Время на действие");
    text("combat-round", combat.round + "/" + prompt.roundLimit);
    element("combat-progress").max = prompt.stepSeconds;
    element("combat-progress").value = Math.min(prompt.stepSeconds, prompt.remaining);
    element("combat-progress").setAttribute("aria-label", prompt.mapTarget ? "До смены цели" : "Время на действие");
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
    element("combat-action").dataset.mapTarget = String(prompt.mapTarget);
    element("combat-action").disabled = prompt.disabled || waiting;
    element("focus-combat").hidden = !prompt.mapTarget;
    element("focus-combat").disabled = waiting;
    text("combat-rule", prompt.mapTarget ? "Цель меняется каждую секунду" : "Один клик на отсчёт · скорость клика не важна");
    element("combat-scope").hidden = modeOf(state) === "individual";
    const bothSides = new Set(members.map(id => state.slots.find(slot => slot.id === id).team)).size > 1;
    text("combat-scope", (bothSides ? "Обе стороны · " : "Твои персонажи · ") + members.length + ". Клик действует только в этой стычке.");
    element("retreat").disabled = members.every(id => state.pawns[id].retreating) || waiting;
    element("retreat").firstChild.textContent = members.length > 1 ? "Отвести своих · " + members.length + " " : "Отступить ";
    element("retreat").querySelector("span").textContent = bothSides ? "к своим респам →" : "к своему респу →";
    const result = prompt.previous;
    const sum = key => prompt.results.reduce((value, item) => value + (Number(item[key]) || 0), 0);
    text("combat-result", members.length > 1 && prompt.results.length ? "Урон " + sum("damage") + (sum("healing") ? " · лечение " + sum("healing") : "") + (prompt.missed ? " · пропуски " + prompt.missed : "") : result ? !result.active ? "Ещё один пропуск подряд — поражение" : "Урон " + result.damage + (result.healing ? " · лечение " + result.healing : "") + (result.boost ? " · ДД +" + result.boost + "%" : "") : "Случайность и состав команд решают исход");
    const buffs = members.filter(id => state.pawns[id]?.aspect === "attack" && combat.empowered?.includes(id)).length;
    const ownTeams = new Set(members.map(id => state.slots.find(slot => slot.id === id)?.team));
    const carriers = (combat.carriers ?? []).filter(id => ownTeams.has(state.slots.find(slot => slot.id === id)?.team));
    text("combat-score", buffs || carriers.length ? "+30% к урону ДД своей команды в этой стычке. Твоих усиленных ДД: " + buffs + ". Бафы не складываются." : "Без бафа питомца. Состав команд показан в блоке боя.");
    if (lastCombat !== combat.id) { lastCombat = combat.id; element("combat").scrollIntoView({ block: "start" }); }
  }

  function render() {
    const compatible = state?.rules === "0.8.2";
    element("loading").hidden = compatible;
    element("lobby").hidden = !compatible || state.phase !== "lobby";
    element("playing").hidden = !compatible || state.phase === "lobby";
    if (!compatible) {
      if (state) text("loading-help", "Ведущему нужно обновить вкладку Owlbear.");
      return;
    }
    const context = panelContext(state, connection, host);
    const { mine, slot, hostControls } = context;
    text("phase", state.phase === "lobby" ? "Лобби" : state.phase === "preparing" ? "Подготовка" : state.phase === "finished" ? "Итог" : state.practice ? "Тренировка" : "Матч идёт");
    if (state.phase === "lobby") { requestedPoint = null; wasMoving = false; lastSelectionKey = ""; combatPressed.clear(); lastCombat = null; focusedCombatId = null; renderLobby(context); return; }
    lastLobby = "";
    const finished = state.phase === "finished", preparing = state.phase === "preparing", pawn = state.pawns[mine];
    const dead = Boolean(pawn?.deadUntil);
    const fights = myFights(), combat = focusedFight(), chosen = selectedIds(state, connection);
    const selectionKey = JSON.stringify([mine, chosen]);
    if (selectionKey !== lastSelectionKey) { requestedPoint = null; wasMoving = false; lastSelectionKey = selectionKey; }
    const mobile = chosen.filter(id => state.pawns[id] && !state.pawns[id].deadUntil);
    const canMove = state.phase === "playing" && mobile.length > 0;
    for (const key of combatPressed) if (!fights.some(fight => key === fight.id + "/" + fight.round)) combatPressed.delete(key);
    renderMultiControls(context); renderFightTabs(fights, combat);
    const role = ASPECTS[pawn?.aspect ?? "attack"];
    text("timer", timer(preparing ? TOTAL : TOTAL - state.elapsed)); text("red-score", state.score.red); text("blue-score", state.score.blue);
    const preparation = preparationPrompt(state, connection);
    element("preparation-card").hidden = !preparation;
    if (preparation) {
      text("preparation-timer", preparation.remaining);
      text("preparation-status", "Матч начнётся через " + preparation.remaining);
      text("preparation-ready", "Готовы " + preparation.readyCount + "/" + preparation.requiredCount);
      text("preparation-help", preparation.eligible ? "Если все игроки готовы, матч начнётся раньше." : "Ожидаем готовность игроков. Можно осмотреть карту.");
      element("ready-early").hidden = !preparation.eligible;
      element("ready-early").disabled = waiting || preparation.disabled;
      text("ready-early", preparation.button);
    }
    element("winner-card").hidden = !finished;
    text("winner", state.winner === "draw" ? "Ничья" : "Победа: " + (TEAM_NAME[state.winner] ?? ""));
    element("restart").hidden = !finished || !hostControls; element("restart").disabled = waiting;
    element("player-card").dataset.dead = String(dead && !mobile.length && !combat);
    text("me", slot ? slot.name : "Режим зрителя");
    text("player-state", pawn ? dead ? pawn.deathReason === "inactive" ? "Поражение без действий" : "Персонаж погиб" : role.short + " · " + role.help : "Присоединиться можно в следующем матче");
    text("control", finished ? "" : preparing ? "Осмотри карту. Движение и бой начнутся после подготовки." : !pawn ? "Наблюдай за точками и счётом" : combat ? "Стычка: " + combat.name + " · действие ниже" : chosen.length > 1 ? "Приказ для " + mobile.length + " живых из " + chosen.length : dead ? "Возрождение через " + Math.max(0, Math.ceil(pawn.deadUntil - state.elapsed)) + " с"
      : pawn.retreating ? "Отступаю к своему респу" : pawn.moving ? requestedPoint ? "Бегу: " + requestedPoint : "Персонаж в пути" : "Выбери точку — персонаж побежит сам");
    if (wasMoving && !pawn?.moving) requestedPoint = null;
    wasMoving = Boolean(pawn?.moving);
    element("health-row").hidden = !pawn; element("health").value = pawn?.hp ?? 0; text("health-label", (pawn?.hp ?? 0) + "/100");
    const activeCombat = state.combats?.find(fight => fight.members.includes(mine));
    const aura = petAuraPrompt(pawn, activeCombat, mine);
    element("pet-charge").hidden = !aura.visible; text("pet-charge", aura.label);
    element("pet-help").hidden = !aura.visible; text("pet-help", aura.help);
    element("combat").hidden = !combat;
    if (combat) renderCombat(combat); else { lastCombat = null; text("combat-score", ""); }
    const selectedInFight = combat && chosen.some(id => combat.members.includes(id));
    text("points-heading", canMove ? selectedInFight ? "Сменить точку / выйти из боя" : "Куда бежать?" : "Контроль точек");
    text("move-label", canMove ? chosen.length > 1 ? "За " + mobile.length + " персонажей" : selectedInFight ? "" : "Нажми точку" : preparing ? "После подготовки" : dead ? "После респа" : "Обзор");
    element("free-move").hidden = !canMove;
    for (const button of pointButtons) {
      const point = state.points.find(point => point.name === button.dataset.point);
      const fight = state.combats?.find(combat => combat.kind === "point" && combat.name === point.name);
      const capture = captureStatus(point), rate = Number.isFinite(point.captureRate) ? point.captureRate : 0;
      const speed = rate === 0 ? "пауза" : (rate > 0 ? "+" : "") + rate.toFixed(2).replace(".", ",") + " п.п./с";
      const status = capture ? capture + " · " + speed : fight ? "Идёт бой" : point.team ? TEAM_NAME[point.team] : "Свободна";
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
    element("practice-opponent").hidden = !state.practice || !hostControls || preparing;
    element("practice-opponent").disabled = Boolean(state.practiceOpponent) || waiting || state.phase !== "playing";
    text("practice-opponent", state.practiceOpponent ? "Соперник направлен к Капле" : "Добавить соперника к Капле");
    element("stop").hidden = finished || !hostControls; element("stop-match").disabled = waiting;
    element("recovery").hidden = !host || hostControls || !["preparing", "playing", "finished"].includes(state.phase);
    element("recover-lobby").disabled = waiting;
  }

  async function run(data) {
    if (!state || waiting) return;
    waiting = true; render();
    try { await send({ ...data, board: state.board, host: state.host, controlMode: modeOf(state) }); notice(""); }
    catch (error) { console.error(error); notice("Команда не отправилась. Попробуй ещё раз."); }
    finally { waiting = false; render(); }
  }
  element("start-form").addEventListener("submit", event => {
    event.preventDefault();
    if (!canStart(state)) return;
    const value = element("route").value;
    if (!element("route").reportValidity()) return;
    void run({ type: "start", routeSeconds: value ? Number(value) : null });
  });
  element("practice").addEventListener("click", () => void run({ type: "start", practice: true }));
  element("control-mode").addEventListener("change", () => void run({ type: "set-control-mode", mode: element("control-mode").value }));
  element("claim-group").addEventListener("click", () => void run({ type: "claim", team: selectedTeam, name }));
  element("active-pawn").addEventListener("change", () => {
    const id = element("active-pawn").value;
    void run({ type: "select-pawns", id, ids: [id] });
  });
  element("move-scope").addEventListener("change", () => {
    const scope = element("move-scope").value, all = ownedIds(state, connection);
    const ids = scope === "single" ? [own()] : scope === "all" ? all : all.filter(id => state.slots.find(slot => slot.id === id).team === scope);
    if (ids.length) void run({ type: "select-pawns", ids, id: ids.includes(own()) ? own() : ids[0] });
  });
  element("take-host").addEventListener("click", () => void run({ type: "take-host" }));
  element("ready-early").addEventListener("click", () => {
    const prompt = preparationPrompt(state, connection);
    if (prompt && !prompt.disabled) void run({ type: "ready-early" });
  });
  element("release").addEventListener("click", () => void run({ type: "release", id: own() }));
  element("practice-opponent").addEventListener("click", () => void run({ type: "practice-opponent" }));
  for (const button of pointButtons) button.addEventListener("click", () => { if (state?.phase !== "playing") return; requestedPoint = button.dataset.point; void run({ type: "move-to-point", id: own(), ids: selectedIds(state, connection), point: button.dataset.point }); });
  element("combat-action").addEventListener("click", async () => {
    const combat = focusedFight();
    if (!combat || waiting) return;
    const roundKey = combat.id + "/" + combat.round;
    const prompt = controllerCombatPrompt(state, combat, connection, combatPressed.has(roundKey));
    if (!prompt || prompt.disabled) return;
    combatPressed.add(roundKey); render();
    try { await send({ type: "combat-click", board: state.board, host: state.host, id: prompt.ids[0], combat: combat.id, round: combat.round }); notice(""); }
    catch (error) { combatPressed.delete(roundKey); notice("Действие не отправилось. Нажми ещё раз."); console.error(error); }
    render();
  });
  element("focus-combat").addEventListener("click", () => {
    if (state?.phase === "playing" && focusedFight()?.stepSeconds === 1) void run({ type: "focus-combat" });
  });
  element("retreat").addEventListener("click", () => {
    if (state?.phase !== "playing") return;
    const combat = focusedFight(), ids = combat?.members.filter(id => state.claims[id]?.connection === connection) ?? selectedIds(state, connection);
    if (ids.length) void run({ type: "retreat", id: ids[0], ids });
  });
  element("restart").addEventListener("click", () => void run({ type: "lobby" }));
  element("stop-match").addEventListener("click", () => { element("stop").open = false; void run({ type: "lobby" }); });
  element("recover-lobby").addEventListener("click", () => {
    if (host && !panelContext(state, connection, host).hostControls && ["preparing", "playing", "finished"].includes(state.phase)) void run({ type: "recover-lobby" });
  });
  return {
    update(next) {
      if (isOlderSnapshot(next, state)) return;
      const changedBoard = state?.board !== next?.board, enteringPreparation = next?.phase === "preparing" && state?.phase !== "preparing";
      state = next;
      if (changedBoard) { lastLobby = ""; lastMine = null; selectedTeam = "red"; selectTeam("red"); }
      if (enteringPreparation) element("play-scroll").scrollTop = 0;
      render();
    },
    portraits(next) { if (JSON.stringify(portraits) === JSON.stringify(next)) return; portraits = next; if (state?.phase === "lobby") render(); },
    disconnected(message) { text("loading-help", message); },
  };
}
