import { NS, TEAM_NAME, DEFAULT_ROUTE_SECONDS, readBoard, newMatch, tick } from "./rules.mjs";

const command = NS + "/command";
const tool = NS + "/run";
const mode = tool + "/drag";
const icon = new URL("./run.svg", import.meta.url).href;
const clock = () => performance.now() / 1000;
const stateKey = NS + "/state";
const homeKey = NS + "/lobby-position";

function label(item, value) {
  if (item.text?.type !== "PLAIN" || item.text.plainText === value) return;
  item.text.plainText = value;
  item.text.richText = [{ type: "paragraph", children: [{ text: value }] }];
}

export async function initialize(OBR) {
  const [role, connection] = await Promise.all([OBR.player.getRole(), OBR.player.getConnectionId()]);
  const host = role === "GM";
  let board = null;
  let match = null;
  let claims = {};
  let state = null;
  let busy = false;
  const pending = [];
  let lastTick = 0;
  let lastPublish = -Infinity;
  let publishedItems = new Map();

  OBR.room.onMetadataChange(metadata => { state = metadata[stateKey]; });
  state = (await OBR.room.getMetadata())[stateKey];

  async function publish() {
    if (!board) {
      await OBR.room.setMetadata({ [stateKey]: undefined });
      return;
    }
    lastPublish = clock();
    const snapshot = {
      board: board.key, host: connection,
      slots: board.slots.map(({ id, name, team }) => ({ id, name, team })),
      claims: { ...claims }, phase: !match ? "lobby" : match.winner ? "finished" : "playing",
    };
    if (match) {
      Object.assign(snapshot, {
        elapsed: match.elapsed, winner: match.winner, score: { ...match.score },
        nextWave: match.nextWave, lastClash: match.lastClash,
        routeSeconds: match.routeSeconds, calibrated: match.calibrated,
        points: match.points.map(({ name, team, clash, progress, capturing }) => ({ name, team, clash, progress, capturing })),
        pets: match.pets.map(({ name, available }) => ({ name, available })),
        pawns: Object.fromEntries(Object.values(match.pawns)
          .filter(pawn => pawn.claim)
          .map(({ id, pet, deadUntil, destination }) => [id, { pet, deadUntil, moving: Boolean(destination) }])),
      });
    }
    state = snapshot;
    await OBR.room.setMetadata({ [stateKey]: snapshot });
  }

  async function syncItems() {
    const desired = new Map();
    for (const pawn of Object.values(match.pawns)) {
      let text = pawn.claim?.name || pawn.name.slice(0, 2);
      if (pawn.deadUntil) text += " · " + Math.ceil(pawn.deadUntil - match.elapsed) + " с";
      if (pawn.pet) text += " · баф";
      desired.set(pawn.id, { text, position: pawn.position, visible: Boolean(pawn.claim), locked: true });
    }
    for (const point of match.points) desired.set(point.id, { text: point.team ? TEAM_NAME[point.team] : "" });
    for (const pet of match.pets) {
      const remaining = Math.max(0, Math.ceil(match.nextWave - match.elapsed));
      desired.set(pet.id, { text: pet.available ? "ГОТОВ" : remaining + " с" });
    }
    for (const [index, id] of board.scores.entries()) {
      desired.set(id, { text: String(match.score[index === 0 ? "red" : "blue"]) });
    }
    const changes = new Map([...desired].filter(([id, values]) => publishedItems.get(id) !== JSON.stringify(values)));
    if (!changes.size) return;
    await OBR.scene.items.updateItems([...changes.keys()], items => {
      for (const item of items) {
        const values = changes.get(item.id);
        label(item, values.text);
        if (values.position) item.position = { ...values.position };
        if (values.visible !== undefined) item.visible = values.visible;
        if (values.locked) {
          const slot = board.slots.find(slot => slot.id === item.id);
          item.metadata ??= {};
          item.metadata[homeKey] ??= { position: { ...slot.position }, locked: slot.locked };
          item.locked = true;
        }
      }
    });
    for (const [id, values] of changes) publishedItems.set(id, JSON.stringify(values));
  }

  async function loadBoard(ready) {
    const previous = board;
    const items = ready ? await OBR.scene.items.getItems() : [];
    const loaded = readBoard(items.map(item => item.metadata?.[homeKey]
      ? { ...item, ...item.metadata[homeKey] }
      : item));
    board = loaded;
    if (!host || (previous && previous.key === loaded?.key)) return;
    match = null;
    claims = {};
    pending.length = 0;
    publishedItems.clear();
    if (board && items.some(item => item.metadata?.[homeKey] && board.slots.some(slot => slot.id === item.id))) {
      await returnToLobby();
      return;
    }
    await publish();
  }

  async function returnToLobby() {
    const slots = new Map(board.slots.map(slot => [slot.id, slot]));
    const points = new Set(board.points.map(point => point.id));
    const pets = new Set(board.pets.map(pet => pet.id));
    await OBR.scene.items.updateItems([...slots.keys(), ...points, ...pets, ...board.scores], items => {
      for (const item of items) {
        const slot = slots.get(item.id);
        if (slot) {
          item.position = { ...slot.position };
          item.visible = true;
          item.locked = slot.locked;
          if (item.metadata?.[homeKey]) delete item.metadata[homeKey];
          label(item, claims[item.id]?.name || slot.name.slice(0, 2));
        } else {
          label(item, points.has(item.id) ? "" : pets.has(item.id) ? "КД" : "0");
        }
      }
    });
    if (match?.practice) claims = {};
    match = null;
    publishedItems.clear();
    await publish();
  }

  const fail = error => {
    console.error("Dominion", error);
    void OBR.notification.show("Доминион: проверьте подключение к сцене.", "ERROR");
  };
  OBR.scene.onReadyChange(ready => { void loadBoard(ready).catch(fail); });
  await loadBoard(await OBR.scene.isReady());

  if (host) {
    OBR.broadcast.onMessage(command, ({ connectionId, data }) => {
      if (!data || !board || state?.host !== connection || data.board !== board.key) return;
      const local = connectionId === connection;
      if (data.type === "move" || data.type === "move-to-point") {
        const pawn = match?.pawns[data.id];
        if (!pawn || match.winner || pawn.deadUntil || pawn.claim?.connection !== connectionId) return;
        const { min, max } = board.bounds;
        const target = data.type === "move-to-point"
          ? board.points.find(point => point.name === data.point)?.position
          : data.position;
        const { x, y } = target || {};
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        pawn.destination = { x: Math.max(min.x, Math.min(max.x, x)), y: Math.max(min.y, Math.min(max.y, y)) };
        return;
      }
      if (data.type === "stop") {
        const pawn = match?.pawns[data.id];
        if (pawn?.claim?.connection === connectionId) pawn.destination = null;
        return;
      }
      const manage = async () => {
        if (!board || data.board !== board.key || state?.host !== connection) return;
        if (data.type === "claim" && !match && board.slots.some(slot => slot.id === data.id) && !claims[data.id]) {
          const name = typeof data.name === "string" ? data.name.trim().slice(0, 24) : "";
          if (!name) return;
          for (const id of Object.keys(claims)) if (claims[id].connection === connectionId) delete claims[id];
          claims[data.id] = { connection: connectionId, name };
          await publish();
        } else if (data.type === "release" && !match && claims[data.id]?.connection === connectionId) {
          delete claims[data.id];
          await publish();
        } else if (data.type === "start" && local && !match) {
          const claimCount = Object.keys(claims).length;
          const practice = data.practice === true;
          if (practice ? claimCount !== 0 : claimCount === 0) return;
          if (practice) {
            const slot = board.slots.find(slot => slot.name.startsWith("К1 · "));
            claims[slot.id] = { connection, name: "К1" };
          }
          const calibrated = Number.isFinite(data.routeSeconds) && data.routeSeconds >= 2 && data.routeSeconds <= 90;
          match = newMatch(board, claims, calibrated ? data.routeSeconds : DEFAULT_ROUTE_SECONDS, calibrated);
          match.practice = practice;
          lastTick = clock();
          publishedItems.clear();
          await syncItems();
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
        if (match.winner || now - lastPublish >= 1) await publish();
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
    const id = Object.keys(state.claims).find(slot => state.claims[slot].connection === connection);
    return id ? { id, board: state.board } : null;
  }

  function moveTo(pawn, position) {
    return OBR.broadcast.sendMessage(command, { type: "move", ...pawn, position }, { destination: "ALL" });
  }

  async function sendTarget(event, force) {
    const active = drag;
    if (!active || (!force && clock() - lastMove < 0.085)) return;
    lastMove = clock();
    // ToolEvent.pointerPosition is already in scene coordinates.
    await moveTo(active, event.pointerPosition);
  }

  function cancelDrag() {
    if (!drag) return;
    const { id, board: boardKey } = drag;
    drag = null;
    void OBR.broadcast.sendMessage(command, { type: "stop", board: boardKey, id }, { destination: "ALL" }).catch(fail);
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
