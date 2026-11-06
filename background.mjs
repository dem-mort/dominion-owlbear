import { NS, TEAM_NAME, DEFAULT_ROUTE_SECONDS, readBoard, newMatch, tick, combatClick, combatViews, aspectOptions, defaultAspect } from "./rules.mjs?v=0.10.0";
import { createLocalVision, originalItem, HOME_KEY, PAWN_KEY, SIGHT_RADIUS } from "./vision.mjs?v=0.10.0";
import { CONTROL_MODES, modeOf, ownedIds, activeId, selectedIds, claimTargetIds, canStart } from "./control.mjs?v=0.10.0";
import { mapTarget, targetPosition, hitTarget } from "./targets.mjs?v=0.10.0";
import { createSnapshotGate, isOlderSnapshot } from "./snapshot-sync.mjs?v=0.10.0";
import { CLASSES, classId, lineupSlots, classTemplate } from "./classes.mjs?v=0.10.0";
import { createAuthority } from "./authority.mjs?v=0.10.0";
import { checkpoint, restoreCheckpoint } from "./checkpoint.mjs?v=0.10.0";

const command = NS + "/command";
const tool = NS + "/run";
const mode = tool + "/drag";
const battleTool = NS + "/combat-target";
const battleMode = battleTool + "/tap";
const battleIcon = new URL("./target.svg", import.meta.url).href;
const icon = new URL("./run.svg", import.meta.url).href;
const clock = () => performance.now() / 1000;
const stateKey = NS + "/state";
const homeKey = HOME_KEY;
const blankImage = new URL("./blank.svg", import.meta.url).href;
// SDK item updaters use Immer draft proxies, which structuredClone cannot copy.
const plainCopy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const epochOf = snapshot => Number.isSafeInteger(snapshot?.epoch) && snapshot.epoch >= 0 ? snapshot.epoch : 0;

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
  let preparation = null;
  let legacySnapshot = null;
  let claims = {};
  let aspects = {};
  let classes = {};
  let controlMode = "individual";
  let active = {}, selections = {};
  let state = null;
  let busy = false;
  const pending = [];
  let lastTick = 0;
  let lastPublish = -Infinity;
  let lastMetadataPublish = -Infinity;
  let broadcastReady = false;
  let lastItemSync = -Infinity;
  let lastCombatRevision = -1;
  let combatDirty = false;
  let planDirty = false;
  let publishedItems = new Map();
  let sceneItems = [];
  let sceneReady = false;
  let sceneLoadVersion = 0;
  let lastWarning = -Infinity;
  let announcedCombats = new Set();
  let repairQueued = false;
  let battleToolReady = false;
  let targetFight = null;
  let previousTool = null;
  let toolTransition = Promise.resolve();
  const sentTargets = new Set();
  const vision = createLocalVision(OBR, connection, role, fail, Command);
  const authority = await createAuthority(OBR, connection, role, clock);
  const lineup = () => lineupSlots(board?.slots ?? [], classes);

  function updateLocal() {
    vision.update(state, sceneItems, sceneReady);
    const mine = new Set(ownedIds(state, connection));
    const fights = sceneReady && state?.phase === "playing" ? (state.combats ?? []).filter(fight => fight.members.some(id => mine.has(id))) : [];
    if (fights.some(fight => !announcedCombats.has(fight.id))) void OBR.action.open().catch(fail);
    announcedCombats = new Set(fights.map(fight => fight.id));
    const target = mapTarget(state, connection);
    const currentTargetKey = target ? target.key + "/epoch:" + epochOf(state) : null;
    for (const key of sentTargets) if (key !== currentTargetKey) sentTargets.delete(key);
    syncBattleTool(target);
  }

  async function focusBattleTool() {
    if (!battleToolReady || !mapTarget(state, connection) || typeof OBR.tool.activateTool !== "function") return;
    const current = typeof OBR.tool.getActiveTool === "function" ? await OBR.tool.getActiveTool() : null;
    if (!mapTarget(state, connection)) return;
    if (current && current !== battleTool) previousTool = current;
    await OBR.tool.activateTool(battleTool);
  }
  function syncBattleTool(target) {
    if (!battleToolReady || targetFight === (target?.combat ?? null)) return;
    targetFight = target?.combat ?? null;
    const currentFight = targetFight;
    toolTransition = toolTransition.then(async () => {
      if (targetFight !== currentFight) return;
      if (currentFight) await focusBattleTool();
      else if (previousTool && typeof OBR.tool.getActiveTool === "function" && typeof OBR.tool.activateTool === "function") {
        const restore = previousTool;
        previousTool = null;
        if (await OBR.tool.getActiveTool() === battleTool && !mapTarget(state, connection)) await OBR.tool.activateTool(restore);
      }
    }).catch(fail);
  }

  const controls = () => ({ slots: lineup(), claims, controlMode, active, selections });
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
    classes = Object.fromEntries((board?.slots ?? []).map(slot => [slot.id, Object.hasOwn(CLASSES, snapshot.classes?.[slot.id]) ? snapshot.classes[slot.id] : classId(snapshot.slots?.find(s => s.id === slot.id) ?? slot)]));
    aspects = Object.fromEntries(lineup().map(slot => {
      const chosen = snapshot.aspects?.[slot.id];
      return [slot.id, aspectOptions(slot).includes(chosen) ? chosen : defaultAspect(slot)];
    }));
    for (const [id, claim] of Object.entries(claims)) claim.aspect = aspects[id];
    controlMode = modeOf(snapshot);
    active = { ...snapshot.active }; selections = plainCopy(snapshot.selections ?? {});
  }
  function lobbyLabel(slot) {
    const selected = lineup().find(s => s.id === slot.id) ?? slot;
    const code = selected.name.slice(0, 2), name = claims[slot.id]?.name;
    if (classId(selected) === classId(slot)) return controlMode === "individual" ? name || code : code + (name ? " · " + name : "");
    return code + " · " + CLASSES[classId(selected)].short + (name ? " · " + name : "");
  }
  async function syncLobbyLabels() {
    if (!sceneReady || !board || match || legacySnapshot || state?.host !== connection) return;
    const labels = new Map(board.slots.map(slot => [slot.id, lobbyLabel(slot)]));
    const images = new Map(lineup().map(slot => {
      const template = classTemplate(sceneItems.map(originalItem), slot);
      return [slot.id, template?.image ?? { url: blankImage, mime: "image/svg+xml", width: 140, height: 140 }];
    }));
    const changed = sceneItems.filter(item => labels.has(item.id) && (item.text?.type === "PLAIN" && item.text.plainText !== labels.get(item.id) || JSON.stringify(item.image) !== JSON.stringify(images.get(item.id))));
    if (!changed.length) return;
    await OBR.scene.items.updateItems(changed, items => {
      for (const item of items) label(item, labels.get(item.id));
      for (const item of items) if (JSON.stringify(item.image) !== JSON.stringify(images.get(item.id))) {
        item.metadata ??= {};
        item.metadata[homeKey] ??= { position: { ...item.position }, locked: item.locked,
          visible: item.visible, image: plainCopy(item.image), text: plainCopy(item.text) };
        item.image = plainCopy(images.get(item.id));
      }
    });
  }

  function applySnapshot(next, persisted = false) {
    // A write sent by the previous host can arrive after its replacement.
    // Never resurrect an older authority, even when its own SDK write was
    // already in flight before the takeover notification reached it.
    if (state && next?.board === state.board && epochOf(next) < epochOf(state)) {
      if (persisted && host && state.host === connection && !repairQueued) {
        repairQueued = true;
        pending.push(async () => {
          repairQueued = false;
          if (sceneReady && state?.host === connection) await publish(false, true);
        });
      }
      return;
    }
    if (isOlderSnapshot(next, state)) return;
    state = next;
    if ((match || legacySnapshot) && state?.host !== connection) {
      match = null;
      preparation = null;
      legacySnapshot = null;
      pending.length = 0;
      repairQueued = false;
    }
    updateLocal();
  }
  OBR.room.onMetadataChange(metadata => applySnapshot(metadata[stateKey], true));
  state = (await OBR.room.getMetadata())[stateKey];
  const snapshotGate = await createSnapshotGate(OBR, connection, role, () => state);

  async function publish(acquire = false, forceMetadata = false) {
    if (!sceneReady) return;
    if (!acquire && board && state?.board === board.key && state.host !== connection) return;
    if (!board) {
      if (state?.host === connection) await OBR.room.setMetadata({ [stateKey]: undefined });
      return;
    }
    lastPublish = clock();
    const previousPhase = state?.phase;
    normalizeSelection();
    const snapshot = {
      ...(legacySnapshot ?? {}),
      rules: "0.10.0",
      board: board.key, host: connection,
      epoch: (state?.board === board.key ? epochOf(state) : 0) + (acquire ? 1 : 0),
      revision: !acquire && state?.board === board.key && Number.isSafeInteger(state.revision) ? state.revision + 1 : 1,
      boardScale: board.scale,
      actionSeconds: match?.stepSeconds ?? (controlMode === "individual" && Object.keys(claims).length === 12 && new Set(Object.values(claims).map(claim => claim.connection)).size === 12 ? 1 : 3),
      slots: lineup().map(({ id, name, team, classId, baseClassId }) => ({ id, name, team, classId, baseClassId })),
      classes: { ...classes }, claims: { ...claims }, aspects: { ...aspects }, controlMode,
      active: controlMode === "individual" ? {} : { ...active }, selections: controlMode === "individual" ? {} : plainCopy(selections),
      phase: legacySnapshot ? legacySnapshot.phase : !match ? "lobby" : preparation ? "preparing" : match.winner ? "finished" : "playing",
      ...(legacySnapshot ? { recoveryRequired: true } : {}),
    };
    if (preparation) snapshot.preparation = {
      remaining: preparation.remaining,
      ready: [...preparation.ready],
      required: [...new Set(Object.values(claims).map(claim => claim.connection))],
    };
    if (match) {
      Object.assign(snapshot, {
        checkpoint: checkpoint(match),
        elapsed: match.elapsed, winner: match.winner, score: { ...match.score },
        nextWave: match.nextWave,
        lastClash: match.lastClash && { ...match.lastClash, rounds: undefined },
        combats: combatViews(match), practice: Boolean(match.practice), practiceOpponent: Boolean(match.practiceOpponent),
        routeSeconds: match.routeSeconds, calibrated: match.calibrated,
        sightRadius: SIGHT_RADIUS * board.scale,
        points: match.points.map(({ name, team, clash, progress, capturing, captureRate }) => ({ name, team, clash, progress, capturing, captureRate })),
        pets: match.pets.map(({ name, available, combat }) => ({ name, available, fighting: Boolean(combat) })),
        pawns: Object.fromEntries(Object.values(match.pawns)
          .filter(pawn => pawn.claim)
          .map(pawn => [pawn.id, { pet: pawn.pet, deadUntil: pawn.deadUntil, deathReason: pawn.deathReason,
            hp: Math.round(pawn.hp), aspect: pawn.aspect, retreating: pawn.retreating,
            moving: !preparation && Boolean(pawn.destination), planned: Boolean(preparation && pawn.destination),
            orderPoint: pawn.destination ? pawn.orderPoint ?? null : null,
            atSpawn: Boolean(pawn.deadUntil) || Math.hypot(pawn.position.x - board.spawn[pawn.team].x, pawn.position.y - board.spawn[pawn.team].y) <= 36 * board.scale }])),
      });
      lastCombatRevision = match.combatRevision;
      combatDirty = false;
    }
    state = snapshot;
    updateLocal();
    // Ephemeral snapshots reach every connection, including multiple tabs of
    // the same account. Metadata remains the reconnect/persistence channel.
    if (broadcastReady) {
      try {
        await OBR.broadcast.sendMessage(command, { type: "snapshot", snapshot }, { destination: "ALL" });
      } catch (error) {
        console.error("Dominion snapshot broadcast", error?.message ?? String(error));
      }
    }
    if (forceMetadata || acquire || snapshot.phase === "lobby" || previousPhase !== snapshot.phase || clock() - lastMetadataPublish >= 1) {
      lastMetadataPublish = clock();
      await OBR.room.setMetadata({ [stateKey]: snapshot });
    }
    if (!match) await syncLobbyLabels();
  }

  async function syncItems(force = false) {
    if (!sceneReady || !match) return;
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
    const loadVersion = ++sceneLoadVersion;
    sceneReady = false;
    lastTick = clock();
    if (!ready) {
      // A newly joined GM often receives false before the existing scene loads.
      // Keep the authoritative snapshot and any in-memory match intact.
      sceneItems = [];
      pending.length = 0;
      repairQueued = false;
      updateLocal();
      return;
    }
    const previous = board;
    updateLocal();
    const items = await OBR.scene.items.getItems();
    if (loadVersion !== sceneLoadVersion) return;
    sceneReady = true;
    lastTick = clock();
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
    if (!sceneReady || loadVersion !== sceneLoadVersion) return;
    // Another GM can acquire the lobby while score migration awaits the SDK.
    if (board && state?.board === board.key && state.host !== connection) {
      restoreControls(state);
      return;
    }
    const savedLobby = board && state?.board === board.key && state.phase === "lobby" ? state : null;
    if (board && state?.board === board.key && state.phase !== "lobby") {
      const saved = state;
      restoreControls(saved);
      match = restoreCheckpoint(board, saved);
      legacySnapshot = match ? null : saved;
      preparation = match && saved.phase === "preparing" ? { remaining: saved.preparation.remaining, ready: new Set(saved.preparation.ready) } : null;
      pending.length = 0; publishedItems.clear(); lastTick = clock();
      await publish(false, true);
      if (match) await syncItems(true);
      return;
    }
    match = null;
    preparation = null;
    if (savedLobby) restoreControls(savedLobby);
    else {
      controlMode = state?.board === board?.key ? modeOf(state) : "individual";
      claims = {};
      active = {}; selections = {};
      classes = Object.fromEntries((board?.slots ?? []).map(slot => [slot.id, classId(slot)]));
      aspects = Object.fromEntries(lineup().map(slot => [slot.id, defaultAspect(slot)]));
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
    legacySnapshot = null;
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
    preparation = null;
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
    if (!sceneReady) return;
    sceneItems = items;
    updateLocal();
  });

  OBR.broadcast.onMessage(command, ({ connectionId, data }) => {
      if (data?.type === "snapshot") {
        void snapshotGate.accept(connectionId, data.snapshot).then(accepted => { if (accepted) applySnapshot(data.snapshot); }).catch(fail);
        return;
      }
      if (connectionId === connection && data?.type === "focus-combat") { void focusBattleTool().catch(fail); return; }
      if (!host) return;
      if (!sceneReady || !data || !board || data.board !== board.key) return;
      const local = connectionId === connection;
      if (data.type === "recover-lobby") {
        if (!local || state?.host === connection || data.host !== state?.host ||
            !["preparing", "playing", "finished"].includes(state?.phase) || pending.length >= 48) return;
        pending.push(async () => {
          if (!sceneReady || data.host !== state?.host || state.host === connection) return;
          controlMode = modeOf(state);
          aspects = { ...state.aspects };
          claims = {}; active = {}; selections = {};
          match = null; preparation = null; legacySnapshot = null;
          // Publish the new authority before restoring shared items. The previous
          // host drops its in-memory simulation on this metadata change.
          await publish(true);
          await returnToLobby();
        });
        return;
      }
      // Only this GM's own connection may acquire an idle lobby. A player or
      // another GM's broadcast cannot acquire it through this handler.
      if (data.type === "take-host") {
        if (!local || match || state?.phase !== "lobby" || pending.length >= 48) return;
        pending.push(async () => {
          if (!sceneReady || match || state?.phase !== "lobby") return;
          claims = plainCopy(state.claims);
          aspects = { ...state.aspects };
          controlMode = modeOf(state);
          active = { ...state.active }; selections = plainCopy(state.selections ?? {});
          await publish(true);
        });
        return;
      }
      if (state?.host !== connection || data.host !== connection) return;
      if (legacySnapshot && data.type !== "lobby") return;
      const commandIds = () => {
        const ids = data.ids === undefined ? [data.id] : data.ids;
        if (!Array.isArray(ids) || !ids.length || ids.length > 12 || new Set(ids).size !== ids.length ||
            ids.some(id => typeof id !== "string" || match?.pawns[id]?.claim?.connection !== connectionId)) return [];
        return ids;
      };
      const living = (planning = false) => !match || preparation && !planning || match.winner ? [] : commandIds().map(id => match.pawns[id]).filter(pawn => !pawn.deadUntil);
      const formation = (index, count) => {
        if (count < 2) return { x: 0, y: 0 };
        const cols = Math.ceil(Math.sqrt(count)), rows = Math.ceil(count / cols), gap = 18 * board.scale;
        return { x: (index % cols - (cols - 1) / 2) * gap, y: (Math.floor(index / cols) - (rows - 1) / 2) * gap };
      };
      if (data.type === "combat-click" || data.type === "combat-target") {
        if (!match || preparation || match.winner) return;
        if (data.id !== undefined && match.pawns[data.id]?.claim?.connection !== connectionId) return;
        const combat = combatViews(match).find(fight => fight.id === data.combat);
        if (!combat || combat.round !== data.round) return;
        if (match.stepSeconds === 1) {
          if (data.type !== "combat-target" || !combat.members.includes(data.id) ||
              data.epoch !== state.epoch || !hitTarget(targetPosition(combat, data.id, board.scale), data.position)) return;
        } else if (data.type === "combat-target") return;
        if (data.ids !== undefined && (!commandIds().length || data.ids.some(id => !combat.members.includes(id)))) return;
        const members = controlMode === "individual" ? [data.id] : combat.members.filter(id => match.pawns[id]?.claim?.connection === connectionId);
        for (const id of members) if (match.pawns[id]?.claim?.connection === connectionId && combatClick(match, id, data.combat, data.round)) combatDirty = true;
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
        const pawns = living(true);
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
          pawn.orderPoint = data.type === "move-to-point" ? data.point : null;
        }
        if (preparation) planDirty = true;
        return;
      }
      if (data.type === "stop") {
        for (const pawn of living(true)) { pawn.destination = null; pawn.retreating = false; pawn.orderPoint = null; }
        if (preparation) planDirty = true;
        return;
      }
      const manage = async () => {
        if (!sceneReady || !board || data.board !== board.key || state?.host !== connection || data.host !== connection) return;
        if (data.type === "set-control-mode" && local && !match && Object.hasOwn(CONTROL_MODES, data.mode)) {
          if (controlMode === data.mode) return;
          controlMode = data.mode; claims = {}; active = {}; selections = {};
          await publish();
        } else if (data.type === "select-pawns") {
          const ids = data.ids;
          if (!Array.isArray(ids) || !ids.length || ids.length > 12 || new Set(ids).size !== ids.length ||
              ids.some(id => claims[id]?.connection !== connectionId) || !ids.includes(data.id)) return;
          active[connectionId] = data.id; selections[connectionId] = [...ids];
          await publish(false, true);
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
        } else if (data.type === "set-class" && !match && (local || claims[data.id]?.connection === connectionId)) {
          const slot = lineup().find(slot => slot.id === data.id);
          if (!slot || !Object.hasOwn(CLASSES, data.classId)) return;
          classes[data.id] = data.classId;
          const selected = lineup().find(slot => slot.id === data.id);
          if (!aspectOptions(selected).includes(aspects[data.id])) aspects[data.id] = defaultAspect(selected);
          if (claims[data.id]) claims[data.id].aspect = aspects[data.id];
          await publish(false, true);
        } else if (data.type === "set-aspect" && !match && (local || claims[data.id]?.connection === connectionId)) {
          const slot = lineup().find(slot => slot.id === data.id);
          if (!slot || !aspectOptions(slot).includes(data.aspect)) return;
          aspects[data.id] = data.aspect;
          if (claims[data.id]) claims[data.id].aspect = data.aspect;
          await publish();
        } else if (data.type === "release" && !match && (!data.id || claims[data.id]?.connection === connectionId)) {
          const ids = controlMode === "individual" ? [data.id] : ownedIds(controls(), connectionId);
          for (const id of ids) delete claims[id];
          await publish();
        } else if (data.type === "ready-early" && preparation && ownedIds(controls(), connectionId).length) {
          if (preparation.ready.has(connectionId)) return;
          preparation.ready.add(connectionId);
          const required = new Set(Object.values(claims).map(claim => claim.connection));
          if ([...required].every(owner => preparation.ready.has(owner))) {
            preparation = null;
            lastTick = clock();
          }
          await publish(false, true);
        } else if (data.type === "start" && local && !match) {
          const claimCount = Object.keys(claims).length;
          const practice = data.practice === true;
          if (practice ? controlMode !== "individual" || claimCount !== 0 : !canStart(controls())) return;
          if (practice) {
            const slot = board.slots.find(slot => slot.name.startsWith("К1 · "));
            claims[slot.id] = { connection, name: "К1", aspect: aspects[slot.id] };
          }
          const calibrated = Number.isFinite(data.routeSeconds) && data.routeSeconds >= 2 && data.routeSeconds <= 90;
          match = newMatch({ ...board, slots: lineup() }, claims, calibrated ? data.routeSeconds : DEFAULT_ROUTE_SECONDS, calibrated);
          match.practice = practice;
          match.stepSeconds = !practice && controlMode === "individual" && claimCount === 12 &&
            new Set(Object.values(claims).map(claim => claim.connection)).size === 12 ? 1 : 3;
          preparation = practice ? null : { remaining: 60, ready: new Set() };
          planDirty = false;
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
          await publish(false, true);
        } else if (data.type === "lobby" && local && (match || legacySnapshot)) {
          await returnToLobby();
        }
      };
      if (pending.length < 48) pending.push(manage);
    });

  broadcastReady = true;
  await authority.ready(sceneReady ? board?.key ?? null : null);
  if (host) {
    setInterval(async () => {
      if (busy || !sceneReady || !board) return;
      busy = true;
      try {
        await authority.ready(board.key);
        if (authority.successor(state) === connection) {
          const saved = state;
          if (saved?.phase === "lobby") {
            restoreControls(saved);
            match = null; preparation = null;
            pending.length = 0;
            lastTick = clock();
            await publish(true, true);
          } else {
            const restored = restoreCheckpoint(board, saved);
            if (restored) {
              restoreControls(saved);
              match = restored;
              preparation = saved.phase === "preparing" ? { remaining: saved.preparation.remaining, ready: new Set(saved.preparation.ready) } : null;
              pending.length = 0;
              lastTick = clock(); publishedItems.clear();
              await publish(true, true);
              await syncItems(true);
            } else if (saved && ["preparing", "playing", "finished"].includes(saved.phase)) {
              restoreControls(saved); legacySnapshot = saved; match = null; preparation = null;
              pending.length = 0;
              await publish(true, true);
            }
          }
        }
        const manage = pending.shift();
        if (manage) await manage();
        if (!sceneReady || !match || state?.host !== connection || match.winner) return;
        const now = clock();
        // Treat a suspended GM tab as a pause, so no pawn jumps.
        const elapsed = Math.min(now - lastTick, 0.25);
        lastTick = now;
        if (preparation) {
          preparation.remaining = Math.max(0, preparation.remaining - elapsed);
          if (preparation.remaining <= 1e-8) preparation = null;
          if (!preparation || planDirty || now - lastPublish >= 1) {
            const changedPlan = planDirty; planDirty = false;
            await publish(false, changedPlan);
          }
          return;
        }
        tick(match, elapsed);
        await syncItems();
        if (!match || state?.host !== connection) return;
        const combatPublishGap = match.stepSeconds === 1 ? 0.25 : 0.4;
        if (match.winner || now - lastPublish >= 1 ||
            ((combatDirty || match.combatRevision !== lastCombatRevision) && now - lastPublish >= combatPublishGap)) await publish();
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
    if (!sceneReady || !["preparing", "playing"].includes(state?.phase) || state.recoveryRequired) return null;
    const id = activeId(state, connection), ids = selectedIds(state, connection);
    return id ? { id, ids, board: state.board, host: state.host } : null;
  }

  function moveTo(pawn, position) {
    return OBR.broadcast.sendMessage(command, { type: "move", ...pawn, position }, { destination: "ALL" });
  }

  async function sendTarget(event, force) {
    const active = drag;
    if (!sceneReady || !active || (!force && clock() - lastMove < 0.4)) return;
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
  await OBR.tool.create({ id: battleTool, defaultMode: battleMode, icons: [{ icon: battleIcon, label: "Бой · нажми цель на карте" }] });
  await OBR.tool.createMode({
    id: battleMode,
    icons: [{ icon: battleIcon, label: "Нажми светящийся круг", filter: { activeTools: [battleTool] } }],
    cursors: [{ cursor: "crosshair", filter: { activeTools: [battleTool] } }],
    onToolDown(_context, event) {
      const target = sceneReady && mapTarget(state, connection);
      const key = target && target.key + "/epoch:" + epochOf(state);
      if (!target || target.ready || sentTargets.has(key) || !hitTarget(target, event.pointerPosition)) return;
      sentTargets.add(key);
      void OBR.broadcast.sendMessage(command, { type: "combat-target", board: state.board, host: state.host, epoch: state.epoch,
        id: target.id, combat: target.combat, round: target.round, position: { ...event.pointerPosition } }, { destination: "ALL" })
        .catch(error => { sentTargets.delete(key); fail(error); });
    },
    onToolClick() { return false; },
  });
  battleToolReady = true;
  updateLocal();
}
