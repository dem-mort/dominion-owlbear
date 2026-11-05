const validId = value => typeof value === "string" && value.trim().length > 0;
const sequence = (snapshot, key) => snapshot?.[key] === undefined ? 0 : snapshot[key];
const validSequence = value => Number.isSafeInteger(value) && value >= 0;
const validSnapshot = snapshot => snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot) &&
  validId(snapshot.host) && validId(snapshot.board) && validId(snapshot.rules) &&
  validSequence(sequence(snapshot, "epoch")) && validSequence(sequence(snapshot, "revision"));

// Epoch orders host takeovers; revision orders updates from the same authority.
// Equality is deliberately accepted so metadata and broadcast can carry a copy.
export function isOlderSnapshot(next, current) {
  if (!validId(next?.board) || next.board !== current?.board) return false;
  const nextEpoch = sequence(next, "epoch"), currentEpoch = sequence(current, "epoch");
  return nextEpoch < currentEpoch || (nextEpoch === currentEpoch && sequence(next, "revision") < sequence(current, "revision"));
}

export async function createSnapshotGate(OBR, connection, role, getCurrent) {
  const party = OBR?.party;
  const available = typeof party?.getPlayers === "function";
  let players = new Map(), generation = 0, refreshing = null;
  const remember = roster => {
    players = new Map((Array.isArray(roster) ? roster : [])
      .filter(player => validId(player?.connectionId))
      .map(player => [player.connectionId, player.role]));
  };
  async function refresh() {
    if (!available) return;
    if (!refreshing) {
      const version = generation;
      refreshing = Promise.resolve().then(() => party.getPlayers())
        .then(roster => { if (generation === version) remember(roster); })
        .catch(() => {}) // A failed roster request grants no new authority.
        .finally(() => { refreshing = null; });
    }
    await refreshing;
  }
  if (available && typeof party.onChange === "function") party.onChange(roster => {
    generation++;
    remember(roster);
  });
  await refresh();

  return {
    async accept(connectionId, snapshot) {
      if (!validId(connectionId) || !validSnapshot(snapshot) || snapshot.host !== connectionId) return false;
      if (connectionId === connection) {
        if (role !== "GM") return false;
      } else if (available) {
        if (!players.has(connectionId)) await refresh();
        if (players.get(connectionId) !== "GM") return false;
      } else if (getCurrent()?.host !== connectionId) return false;
      return !isOlderSnapshot(snapshot, getCurrent());
    },
  };
}
