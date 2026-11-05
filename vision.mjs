import { boardPanelViews } from "./board-panel.mjs?v=0.4.3";
import { distance, NS, POINT_NAMES, ASPECTS } from "./rules.mjs?v=0.4.0";

export const HOME_KEY = NS + "/lobby-position";
export const PAWN_KEY = NS + "/pawn";
export const VIEW_KEY = NS + "/local-view";
export const HELP_KEY = NS + "/help-view";
export const SIGHT_RADIUS = 72;


export function originalItem(item) {
  return item.metadata?.[HOME_KEY] ? { ...item, ...item.metadata[HOME_KEY] } : item;
}

export function visiblePawns(state, items, connection, role) {
  if (!state || !["playing", "finished"].includes(state.phase)) return [];
  const sources = new Map(items.map(item => [item.id, item]));
  const viewer = state.slots.find(slot => state.claims[slot.id]?.connection === connection);
  const eye = viewer && sources.get(viewer.id);
  const eyeStatus = eye?.metadata?.[PAWN_KEY];
  const referee = role === "GM" && !viewer;
  const radius = state.sightRadius;
  return state.slots.flatMap(slot => {
    const claim = state.claims[slot.id];
    const source = sources.get(slot.id);
    const status = source?.metadata?.[PAWN_KEY];
    if (!claim || !source || !status) return [];
    const ally = slot.team === viewer?.team;
    const nearby = eyeStatus && !eyeStatus.deadUntil && !status.deadUntil &&
      Number.isFinite(radius) && radius > 0 && distance(eye.position, source.position) <= radius;
    if (!referee && !ally && !nearby) return [];
    const original = originalItem(source);
    const text = structuredClone(original.text);
    let nickname = slot.name.slice(0, 2);
    if (claim.name && claim.name !== nickname) nickname += " · " + claim.name;
    if (ASPECTS[status.aspect]) nickname += " · " + ASPECTS[status.aspect].short;
    if (!status.deadUntil && Number.isFinite(status.hp) && status.hp < 100) nickname += " · " + status.hp + "%";
    if (status.deadUntil) nickname += " · " + Math.max(0, Math.ceil(status.deadUntil - state.elapsed)) + " с";
    if (status.pet) nickname += " · баф";
    if (text?.type === "PLAIN") {
      text.plainText = nickname;
      text.richText = [{ type: "paragraph", children: [{ text: nickname }] }];
    }
    const item = {
      ...original,
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
  return JSON.stringify([item.position, item.rotation, item.scale, item.image, item.grid, item.text, item.name]);
}

// Local items belong to this browser's view. They never change shared visibility.
export function createLocalVision(OBR, connection, role, onError) {
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

        const desired = new Map(visiblePawns(snapshot.state, snapshot.items, connection, role)
          .map(view => [view.source, view.item]));
        for (const view of boardPanelViews(snapshot.state, snapshot.items)) desired.set(view.source, view.item);
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
                item.image = next.image;
                item.grid = next.grid;
                item.text = next.text;
                item.name = next.name;
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
