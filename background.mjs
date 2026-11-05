import { NS, TEAM_NAME, DEFAULT_ROUTE_SECONDS, readBoard, newMatch, tick, combatClick, combatViews, aspectOptions, defaultAspect } from "./rules.mjs?v=0.4.0";
import { createLocalVision, originalItem, HOME_KEY, PAWN_KEY, SIGHT_RADIUS } from "./vision.mjs?v=0.6.0";
import { CONTROL_MODES, modeOf, ownedIds, activeId, selectedIds, claimTargetIds, canStart } from "./control.mjs?v=0.6.0";

const command = NS + "/command";
const tool = NS + "/run";
const mode = tool + "/drag";
const icon = new URL("./run.svg", import.meta.url).href;
const clock = () => performance.now() / 1000;
const stateKey = NS + "/state";
const homeKey = HOME_KEY;
const blankImage = new URL("./blank.svg", import.meta.url).href;
// SDK item updaters use Immer draft proxies, which structuredClone cannot copy.
const plainCopy = value => value == null ? value : JSON.parse(JSON.stringify(value));

function label(item, value) {
  if (item.text?.type !== "PLAIN" || item.text.plainText === value) return;
  item.text.plainText = value;
  item.text.richText = [{ type: "paragraph", children: [{ text: value }] }];
}

export async function initialize(OBR, Command) {
  const [role, connection] = await Promise.all([OBR.player.getRole(), OBR.player.getConnectionId()]);
  const host = role === "GM";
  let board = null;
  let match = null;
  let claims = {};
  let aspects = {};
  let controlMode = "individual";
  let active = {}, selections = {};
  let state = null;
  let busy = false;
  const pending = [];
  let lastTick = 0;
  let lastPublish = -Infinity;
  let lastItemSync = -Infinity;
  let lastCombatRevision = -1;
  let publishedItems = new Map();
  let sceneItems = [];
  let sceneReady = false;
  let lastWarning = -Infinity;
  let announcedCombats = new Set();
  const vision = createLocalVision(OBR, connection, role, fail, Command);

  function updateLocal() {
    vision.update(state, sceneItems, sceneReady);
    const mine = new Set(ownedIds(state, connection));
    const fights = state?.phase === "playing" ? (state.combats ?? []).filter(fight => fight.members.some(id => mine.has(id))) : [];
    if (fights.some(fight => !announcedCombats.has(fight.id))) void OBR.action.open().catch(fail);
    announcedCombats = new Set(fights.map(fight => fight.id));
  }

  const controls = () => ({ slots: board?.slots ?? [], claims, controlMode, active, selections });
  function normalizeSelection() {
    const current = controls(), owners = new Set(Object.values(claims).map(claim => claim.connection));
    const nextActive = {}, nextSelections = {};
    for (const owner of owners) {
      nextSelections[owner] = selectedIds(current, owner);
      const chosen = activeId(current, owner);
      nextActive[owner] = nextSelections[owner].includes(chosen) ? chosen : nextSelections[owner][0];
    }
    active = nextActive; selections = nextSelections;
  }
  function restoreControls(snapshot) {
    claims = plainCopy(snapshot.claims ?? {});
    aspects = { ...Object.fromEntries((board?.slots ?? []).map(slot => [slot.id, defaultAspect(slot)])), ...snapshot.aspects };
    controlMode = modeOf(snapshot);
    active = { ...snapshot.active }; selections = plainCopy(snapshot.selections ?? {});
  }
  function lobbyLabel(slot) {
    const code = slot.name.slice(0, 2), name = claims[slot.id]?.name;
    return controlMode === "individual" ? name || code : code + (name ? " · " + name : "");
  }
  async function syncLobbyLabels() {
    if (!board || match) return;
    const labels = new Map(board.slots.map(slot => [slot.id, lobbyLabel(slot)]));
    const changed = sceneItems.filter(item => labels.has(item.id) && item.text?.type === "PLAIN" && item.text.plainText !== labels.get(item.id));
    if (!changed.length) return;
    await OBR.scene.items.updateItems(changed, items => {
      for (const item of items) label(item, labels.get(item.id));
    });
  }

  OBR.room.onMetadataChange(metadata => {
    state = metadata[stateKey];
    updateLocal();
  });
  state = (await OBR.room.getMetadata())[stateKey];

  async function publish() {
    if (!board) {
      await OBR.room.setMetadata({ [stateKey]: undefined });
      return;
    }
    lastPublish = clock();
    normalizeSelection();
    const snapshot = {
      rules: "0.6.0",
      board: board.key, host: connection,
      slots: board.slots.map(({ id, name, team }) => ({ id, name, team })),
      claims: { ...claims }, aspects: { ...aspects }, controlMode, active: { ...active }, selections: plainCopy(selections),
      phase: !match ? "lobby" : match.winner ? "finished" : "playing",
    };
    if (match) {
      Object.assign(snapshot, {
        elapsed: match.elapsed, winner: match.winner, score: { ...match.score },
        nextWave: match.nextWave,
        lastClash: match.lastClash && { ...match.lastClash, rounds: undefined },
        combats: combatViews(match), practice: Boolean(match.practice), practiceOpponent: Boolean(match.practiceOpponent),
        routeSeconds: match.routeSeconds, calibrated: match.calibrated,
        sightRadius: SIGHT_RADIUS * board.scale,
        points: match.points.map(({ name, team, clash, progress, capturing }) => ({ name, team, clash, progress, capturing })),
        pets: match.pets.map(({ name, available, combat }) => ({ name, available, fighting: Boolean(combat) })),
        pawns: Object.fromEntries(Object.values(match.pawns)
          .filter(pawn => pawn.claim)
          .map(({ id, pet, deadUntil, destination, deathReason, hp, aspect, retreating }) => [id, { pet, deadUntil, deathReason, hp: Math.round(hp), aspect, retreating, moving: Boolean(destination) }])),
      });
      lastCombatRevision = match.combatRevision;
    }
    state = snapshot;
    updateLocal();
    await OBR.room.setMetadata({ [stateKey]: snapshot });
    if (!match) await syncLobbyLabels();
  }

  async function syncItems(force = false) {
    // Keep the 100 ms simulation independent of Owlbear's SDK request budget.
    if (!force && clock() - lastItemSync < 0.4 - 1e-8) return;
    const desired = new Map();
    for (const pawn of Object.values(match.pawns)) {
      desired.set(pawn.id, {
        text: "", position: pawn.position, visible: false, locked: true,
        pawn: { pet: pawn.pet, deadUntil: pawn.deadUntil, hp: Math.round(pawn.hp), aspect: pawn.aspect },
      });
    }
    for (const point of match.points) desired.set(point.id, { text: point.team ? TEAM_NAME[point.team] : "" });
    for (const pet of match.pets) {
      const remaining = Math.max(0, Math.ceil(match.nextWave - match.elapsed));
      desired.set(pet.id, { text: pet.available ? "ГОТОВ" : remaining + " с" });
    }
    for (const id of board.scores) {
      desired.set(id, { text: "" });
    }
    const changes = new Map([...desired].filter(([id, values]) => publishedItems.get(id) !== JSON.stringify(values)));
    if (!changes.size) return;
    lastItemSync = clock();
    // Passing the cached records avoids the SDK's extra getItems request.
    await OBR.scene.items.updateItems(sceneItems.filter(item => changes.has(item.id)), items => {
      for (const item of items) {
        const values = changes.get(item.id);
        if (values.pawn) {
          const slot = board.slots.find(slot => slot.id === item.id);
          item.metadata ??= {};
          item.metadata[homeKey] ??= {
            position: { ...slot.position }, locked: slot.locked,
            visible: item.visible, image: plainCopy(item.image), text: plainCopy(item.text),
          };
          item.metadata[PAWN_KEY] = values.pawn;
          item.image = { url: blankImage, mime: "image/svg+xml", width: 140, height: 140 };
        }
        label(item, values.text);
        if (values.position) item.position = { ...values.position };
        if (values.visible !== undefined) item.visible = values.visible;
        if (values.locked) {
          item.locked = true;
        }
      }
    });
    for (const [id, values] of changes) publishedItems.set(id, JSON.stringify(values));
  }

  async function loadBoard(ready) {
    const previous = board;
    const items = ready ? await OBR.scene.items.getItems() : [];
    sceneReady = ready;
    sceneItems = items;
    updateLocal();
    const loaded = readBoard(items.map(originalItem));
    board = loaded;
    if (!host || (previous && previous.key === loaded?.key)) return;
    // Opening another GM browser must not reset the existing lobby or match.
    // It can explicitly acquire the idle lobby with take-host instead.
    if (board && state?.board === board.key && state.host !== connection) {
      restoreControls(state);
      return;
    }
    if (board) {
      await OBR.scene.items.updateItems(board.scores, items => {
        for (const item of items) {
          item.metadata ??= {};
          item.metadata[NS + "/legacy-score-text"] ??= { textItemType: item.textItemType ?? "LABEL", text: plainCopy(item.text), locked: Boolean(item.locked) };
          item.textItemType = "TEXT";
          item.locked = true;
          label(item, "");
        }
      });
    }
    // Another GM can acquire the lobby while score migration awaits the SDK.
    if (board && state?.board === board.key && state.host !== connection) {
      restoreControls(state);
      return;
    }
    const savedLobby = board && state?.board === board.key && state.phase === "lobby" ? state : null;
    match = null;
    if (savedLobby) restoreControls(savedLobby);
    else {
      controlMode = state?.board === board?.key ? modeOf(state) : "individual";
      claims = {};
      active = {}; selections = {};
      aspects = Object.fromEntries((board?.slots ?? []).map(slot => [slot.id, defaultAspect(slot)]));
    }
    pending.length = 0;
    publishedItems.clear();
    if (board && items.some(item => item.metadata?.[homeKey] && board.slots.some(slot => slot.id === item.id))) {
      await returnToLobby();
      return;
    }
    await publish();
  }

  async function returnToLobby() {
    if (match?.practice) { claims = {}; active = {}; selections = {}; }
    const slots = new Map(board.slots.map(slot => [slot.id, slot]));
    const points = new Set(board.points.map(point => point.id));
    const pets = new Set(board.pets.map(pet => pet.id));
    await OBR.scene.items.updateItems([...slots.keys(), ...points, ...pets, ...board.scores], items => {
      for (const item of items) {
        const slot = slots.get(item.id);
        if (slot) {
          const original = originalItem(item);
          item.position = { ...slot.position };
          item.visible = true;
          item.locked = slot.locked;
          if (original.image) item.image = plainCopy(original.image);
          if (original.text) item.text = plainCopy(original.text);
          if (item.metadata?.[homeKey]) delete item.metadata[homeKey];
          if (item.metadata?.[PAWN_KEY]) delete item.metadata[PAWN_KEY];
          label(item, lobbyLabel(slot));
        } else {
          label(item, pets.has(item.id) ? "КД" : "");
        }
      }
    });
    match = null;
    publishedItems.clear();
    await publish();
  }

  function fail(error) {
    console.error("Dominion", error?.message ?? JSON.stringify(error));
    if (clock() - lastWarning >= 5) {
      lastWarning = clock();
      void OBR.notification.show("Доминион: проверьте подключение к сцене.", "ERROR");
    }
  }
  OBR.scene.onReadyChange(ready => { void loadBoard(ready).catch(fail); });
  await loadBoard(await OBR.scene.isReady());
  OBR.scene.items.onChange(items => {
    sceneItems = items;
    updateLocal();
  });

  if (host) {
    OBR.broadcast.onMessage(command, ({ connectionId, data }) => {
      if (!data || !board || data.board !== board.key) return;
      const local = connectionId === connection;
      // Only this GM's own connection may acquire an idle lobby. A player or
      // another GM's broadcast cannot acquire it through this handler.
      if (data.type === "take-host") {
        if (!local || match || state?.phase !== "lobby" || pending.length >= 48) return;
        pending.push(async () => {
          if (match || state?.phase !== "lobby") return;
          claims = plainCopy(state.claims);
          aspects = { ...state.aspects };
          controlMode = modeOf(state);
          active = { ...state.active }; selections = plainCopy(state.selections ?? {});
          await publish();
        });
        return;
      }
      if (state?.host !== connection || data.host !== connection) return;
      const commandIds = () => {
        const ids = data.ids === undefined ? [data.id] : data.ids;
        if (!Array.isArray(ids) || !ids.length || ids.length > 12 || new Set(ids).size !== ids.length ||
            ids.some(id => typeof id !== "string" || match?.pawns[id]?.claim?.connection !== connectionId)) return [];
        return ids;
      };
      const living = () => !match || match.winner ? [] : commandIds().map(id => match.pawns[id]).filter(pawn => !pawn.deadUntil);
      const formation = (index, count) => {
        if (count < 2) return { x: 0, y: 0 };
        const cols = Math.ceil(Math.sqrt(count)), rows = Math.ceil(count / cols), gap = 18 * board.scale;
        return { x: (index % cols - (cols - 1) / 2) * gap, y: (Math.floor(index / cols) - (rows - 1) / 2) * gap };
      };
      if (data.type === "combat-click") {
        if (!match || match.winner) return;
        if (data.id !== undefined && match.pawns[data.id]?.claim?.connection !== connectionId) return;
        const combat = combatViews(match).find(fight => fight.id === data.combat);
        if (!combat || combat.round !== data.round) return;
        if (data.ids !== undefined && (!commandIds().length || data.ids.some(id => !combat.members.includes(id)))) return;
        const members = controlMode === "individual" ? [data.id] : combat.members.filter(id => match.pawns[id]?.claim?.connection === connectionId);
        for (const id of members) if (match.pawns[id]?.claim?.connection === connectionId) combatClick(match, id, data.combat, data.round);
        return;
      }
      if (data.type === "retreat") {
        const pawns = living();
        for (const team of ["red", "blue"]) {
          const side = pawns.filter(pawn => pawn.team === team);
          for (const [index, pawn] of side.entries()) {
            const offset = formation(index, side.length);
            pawn.destination = { x: board.spawn[team].x + offset.x, y: board.spawn[team].y + offset.y };
            pawn.retreating = true;
          }
        }
        return;
      }
      if (data.type === "move" || data.type === "move-to-point") {
        const pawns = living();
        if (!pawns.length) return;
        const { min, max } = board.bounds;
        const target = data.type === "move-to-point"
          ? board.points.find(point => point.name === data.point)?.position
          : data.position;
        const { x, y } = target || {};
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        for (const [index, pawn] of pawns.entries()) {
          const offset = formation(index, pawns.length);
          pawn.destination = { x: Math.max(min.x, Math.min(max.x, x + offset.x)), y: Math.max(min.y, Math.min(max.y, y + offset.y)) };
          pawn.retreating = false;
        }
        return;
      }
      if (data.type === "stop") {
        for (const pawn of living()) { pawn.destination = null; pawn.retreating = false; }
        return;
      }
      const manage = async () => {
        if (!board || data.board !== board.key || state?.host !== connection || data.host !== connection) return;
        if (data.type === "set-control-mode" && local && !match && Object.hasOwn(CONTROL_MODES, data.mode)) {
          if (controlMode === data.mode) return;
          controlMode = data.mode; claims = {}; active = {}; selections = {};
          await publish();
        } else if (data.type === "select-pawns") {
          const ids = data.ids;
          if (!Array.isArray(ids) || !ids.length || ids.length > 12 || new Set(ids).size !== ids.length ||
              ids.some(id => claims[id]?.connection !== connectionId) || !ids.includes(data.id)) return;
          active[connectionId] = data.id; selections[connectionId] = [...ids];
          await publish();
        } else if (data.type === "claim" && !match) {
          if (data.controlMode !== undefined && data.controlMode !== controlMode) return;
          const name = typeof data.name === "string" ? data.name.trim().slice(0, 24) : "";
          if (!name) return;
          const targets = claimTargetIds(controls(), data);
          if (!targets.length || targets.some(id => claims[id] && claims[id].connection !== connectionId)) return;
          for (const id of Object.keys(claims)) if (claims[id].connection === connectionId) delete claims[id];
          for (const id of targets) claims[id] = { connection: connectionId, name, aspect: aspects[id] };
          active[connectionId] = targets.includes(data.id) ? data.id : targets[0];
          selections[connectionId] = [active[connectionId]];
          await publish();
        } else if (data.type === "set-aspect" && !match && (local || claims[data.id]?.connection === connectionId)) {
          const slot = board.slots.find(slot => slot.id === data.id);
          if (!slot || !aspectOptions(slot).includes(data.aspect)) return;
          aspects[data.id] = data.aspect;
          if (claims[data.id]) claims[data.id].aspect = data.aspect;
          await publish();
        } else if (data.type === "release" && !match && (!data.id || claims[data.id]?.connection === connectionId)) {
          const ids = controlMode === "individual" ? [data.id] : ownedIds(controls(), connectionId);
          for (const id of ids) delete claims[id];
          await publish();
        } else if (data.type === "start" && local && !match) {
          const claimCount = Object.keys(claims).length;
          const practice = data.practice === true;
          if (practice ? controlMode !== "individual" || claimCount !== 0 : !canStart(controls())) return;
          if (practice) {
            const slot = board.slots.find(slot => slot.name.startsWith("К1 · "));
            claims[slot.id] = { connection, name: "К1", aspect: aspects[slot.id] };
          }
          const calibrated = Number.isFinite(data.routeSeconds) && data.routeSeconds >= 2 && data.routeSeconds <= 90;
          match = newMatch(board, claims, calibrated ? data.routeSeconds : DEFAULT_ROUTE_SECONDS, calibrated);
          match.practice = practice;
          lastTick = clock();
          publishedItems.clear();
          await syncItems(true);
          await publish();
        } else if (data.type === "practice-opponent" && local && match?.practice && !match.winner && !match.practiceOpponent) {
          const slot = board.slots.find(slot => slot.name.startsWith("С1 · "));
          const claim = { connection: NS + "/practice-bot", name: "Учебный", aspect: aspects[slot.id] };
          claims[slot.id] = claim;
          match.pawns[slot.id].claim = claim;
          match.pawns[slot.id].aspect = claim.aspect;
          match.pawns[slot.id].bot = true;
          match.pawns[slot.id].destination = { ...match.points[1].position };
          match.practiceOpponent = true;
          await publish();
        } else if (data.type === "lobby" && local && match) {
          await returnToLobby();
        }
      };
      if (pending.length < 48) pending.push(manage);
    });

    setInterval(async () => {
      if (busy || !board) return;
      busy = true;
      try {
        const manage = pending.shift();
        if (manage) await manage();
        if (!match || match.winner) return;
        const now = clock();
        // Treat a suspended GM tab as a pause, so no pawn jumps.
        const elapsed = Math.min(now - lastTick, 0.25);
        lastTick = now;
        tick(match, elapsed);
        await syncItems();
        if (match.winner || now - lastPublish >= 1 ||
            (match.combatRevision !== lastCombatRevision && now - lastPublish >= 0.4)) await publish();
      } catch (error) {
        fail(error);
      } finally {
        busy = false;
      }
    }, 100);
  }

  let drag = null;
  let lastMove = 0;

  function ownPawn() {
    if (state?.phase !== "playing") return null;
    const id = activeId(state, connection), ids = selectedIds(state, connection);
    return id ? { id, ids, board: state.board, host: state.host } : null;
  }

  function moveTo(pawn, position) {
    return OBR.broadcast.sendMessage(command, { type: "move", ...pawn, position }, { destination: "ALL" });
  }

  async function sendTarget(event, force) {
    const active = drag;
    if (!active || (!force && clock() - lastMove < 0.4)) return;
    lastMove = clock();
    // ToolEvent.pointerPosition is already in scene coordinates.
    await moveTo(active, event.pointerPosition);
  }

  function cancelDrag() {
    if (!drag) return;
    const cancelled = drag;
    drag = null;
    void OBR.broadcast.sendMessage(command, { type: "stop", ...cancelled }, { destination: "ALL" }).catch(fail);
  }

  await OBR.tool.create({ id: tool, defaultMode: mode, icons: [{ icon, label: "Бег · Доминион" }] });
  await OBR.tool.createMode({
    id: mode,
    icons: [{ icon, label: "Бег · ведите фишку курсором", filter: { activeTools: [tool] } }],
    onToolClick(_context, event) {
      const pawn = ownPawn();
      if (pawn) void moveTo(pawn, event.pointerPosition).catch(fail);
    },
    onToolDragStart(_context, event) {
      drag = ownPawn();
      void sendTarget(event, true).catch(fail);
    },
    onToolDragMove(_context, event) { void sendTarget(event, false).catch(fail); },
    onToolDragEnd(_context, event) {
      if (!drag) return;
      void sendTarget(event, true).catch(fail);
      drag = null;
    },
    onToolDragCancel: cancelDrag,
    onDeactivate: cancelDrag,
  });
}
