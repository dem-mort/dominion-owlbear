import { boardPanelViews } from "./board-panel.mjs?v=0.11.2";
import { targetViews } from "./targets.mjs?v=0.11.2";
import { distance, NS, POINT_NAMES } from "./rules.mjs?v=0.11.2";
import { CLASSES, classId } from "./classes.mjs?v=0.11.2";
import { pawnStyle } from "./pawn-style.mjs?v=0.11.2";
import { planViews } from "./planning.mjs?v=0.11.2";
import { selectedIds } from "./control.mjs?v=0.11.2";

export const HOME_KEY = NS + "/lobby-position";
export const PAWN_KEY = NS + "/pawn";
export const VIEW_KEY = NS + "/local-view";
export const HELP_KEY = NS + "/help-view";
export const SIGHT_RADIUS = 72;


export function originalItem(item) {
  return item.metadata?.[HOME_KEY] ? { ...item, ...item.metadata[HOME_KEY] } : item;
}

export function visiblePawns(state, items, connection, role) {
  if (!state || !["preparing", "playing", "finished"].includes(state.phase)) return [];
  const sources = new Map(items.map(item => [item.id, item]));
  const owned = state.slots.filter(slot => state.claims[slot.id]?.connection === connection);
  const viewer = owned[0];
  const soloController = state.controlMode === "solo" && Boolean(viewer);
  // A team controller sees through every living pawn they own. Selecting a
  // different pawn changes controls, not the team's already shared sight.
  const eyes = (state.controlMode === "teams" ? owned : viewer ? [viewer] : [])
    .map(slot => sources.get(slot.id))
    .filter(source => source?.metadata?.[PAWN_KEY] && !source.metadata[PAWN_KEY].deadUntil);
  const referee = role === "GM" && !viewer;
  const radius = state.sightRadius;
  return state.slots.flatMap(slot => {
    const claim = state.claims[slot.id];
    const source = sources.get(slot.id);
    const status = source?.metadata?.[PAWN_KEY];
    if (!claim || !source || !status) return [];
    const ally = slot.team === viewer?.team;
    const nearby = !status.deadUntil && Number.isFinite(radius) && radius > 0 &&
      eyes.some(eye => distance(eye.position, source.position) <= radius);
    if (!referee && !soloController && !ally && !nearby) return [];
    const original = originalItem(source);
    const text = { ...structuredClone(original.text ?? {}), type: "PLAIN", plainText: "",
      richText: [{ type: "paragraph", children: [{ text: "" }] }] };
    const item = {
      ...original,
      ...pawnStyle(slot, state.boardScale),
      name: CLASSES[classId(slot)].name,
      position: { ...source.position },
      visible: true,
      locked: true,
      disableHit: true,
      text,
      metadata: { [VIEW_KEY]: source.id },
    };
    delete item.attachedTo;
    return [{ source: source.id, item }];
  });
}

function signature(item) {
  return JSON.stringify([item.position, item.rotation, item.scale, item.image, item.grid, item.text, item.name, item.commands, item.style, item.metadata]);
}

export function selectionViews(state, items, connection, Command) {
  if (!Command || !["preparing", "playing"].includes(state?.phase) || state.recoveryRequired) return [];
  const { MOVE: M, CUBIC: C, CLOSE: Z } = Command, scale = state.boardScale ?? 1, r = 13 * scale, k = r * .55228475;
  return selectedIds(state, connection).flatMap(id => {
    const source = items.find(item => item.id === id);
    if (!source?.position || ![source.position.x, source.position.y].every(Number.isFinite)) return [];
    const key = VIEW_KEY + "/selection/" + id;
    return [{ source: key, item: { id, createdUserId: source.createdUserId ?? "unknown", type: "PATH", name: "Выбран · " + state.slots.find(s => s.id === id).name,
      layer: "NOTE", zIndex: 9000, visible: true, locked: true, disableHit: true, position: { ...source.position }, rotation: 0, scale: { x: 1, y: 1 },
      fillRule: "nonzero", commands: [[M, 0, -r], [C, k, -r, r, -k, r, 0], [C, r, k, k, r, 0, r], [C, -k, r, -r, k, -r, 0], [C, -r, -k, -k, -r, 0, -r], [Z]],
      style: { fillColor: "#000000", fillOpacity: 0, strokeColor: "#b5ffe1", strokeOpacity: 1, strokeWidth: 1.5 * scale, strokeDash: [3 * scale, 2 * scale] }, metadata: { [VIEW_KEY]: key } } }];
  });
}

// Local items belong to this browser's view. They never change shared visibility.
export function createLocalVision(OBR, connection, role, onError, Command) {
  let current = { state: null, items: [], ready: false };
  let views = new Map();
  let dirty = false;
  let running = false;
  let cleanup = true;
  let generation = 0;

  async function flush() {
    running = true;
    try {
      while (dirty) {
        dirty = false;
        const version = generation;
        const snapshot = current;
        if (!snapshot.ready) continue;
        if (cleanup) {
          const stale = await OBR.scene.local.getItems(item => Boolean(item.metadata?.[VIEW_KEY] || item.metadata?.[HELP_KEY]));
          if (version !== generation) continue;
          if (stale.length) await OBR.scene.local.deleteItems(stale.map(item => item.id));
          if (version !== generation) continue;
          cleanup = false;
        }

        const visible = visiblePawns(snapshot.state, snapshot.items, connection, role);
        const desired = new Map(visible.map(view => [view.source, view.item]));
        for (const view of boardPanelViews(snapshot.state, snapshot.items, Command, connection, role)) desired.set(view.source, view.item);
        for (const view of planViews(snapshot.state, snapshot.items, connection, role, Command)) desired.set(view.source, view.item);
        for (const view of selectionViews(snapshot.state, snapshot.items, connection, Command)) desired.set(view.source, view.item);
        for (const view of targetViews(snapshot.state, snapshot.items, connection, Command)) desired.set(view.source, view.item);
        const removed = [...views.keys()].filter(id => !desired.has(id));
        if (removed.length) {
          await OBR.scene.local.deleteItems(removed.map(id => views.get(id).item.id));
          if (version !== generation) continue;
          for (const id of removed) views.delete(id);
        }
        const additions = [];
        const updates = [];
        for (const [source, item] of desired) {
          const old = views.get(source);
          const next = { ...item, id: old?.item.id ?? crypto.randomUUID() };
          const entry = { source, item: next, signature: signature(next) };
          if (!old) additions.push(entry);
          else if (old.signature !== entry.signature) updates.push(entry);
        }
        if (additions.length) {
          await OBR.scene.local.addItems(additions.map(entry => entry.item));
          if (version !== generation) continue;
          for (const entry of additions) views.set(entry.source, entry);
        }
        if (updates.length) {
          const nextById = new Map(updates.map(entry => [entry.item.id, entry.item]));
          await OBR.scene.local.updateItems(
            updates.map(entry => views.get(entry.source).item),
            drafts => {
              for (const item of drafts) {
                const next = nextById.get(item.id);
                item.position = next.position;
                item.rotation = next.rotation;
                item.scale = next.scale;
                if (next.type === "PATH") { item.commands = next.commands; item.style = next.style; }
                else { item.image = next.image; item.grid = next.grid; item.text = next.text; }
                item.name = next.name;
                item.metadata = next.metadata;
              }
            },
          );
          if (version !== generation) continue;
          for (const entry of updates) views.set(entry.source, entry);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    update(state, items, ready) {
      if (current.ready && !ready) {
        generation++;
        views = new Map();
        cleanup = true;
      }
      current = { state, items, ready };
      dirty = true;
      if (!running) void flush().catch(error => {
        cleanup = true;
        views = new Map();
        onError(error);
      });
    },
  };
}
