// A single deterministic successor among connected, initialized GM controllers.
// Party excludes the local player, so always add this connection explicitly.
export const CONTROLLER_KEY = "ru.allods.dominion/controller";
export async function createAuthority(OBR, connection, role, now) {
  const supported = role === "GM" && typeof OBR.party?.getPlayers === "function" &&
    typeof OBR.party?.onChange === "function" && typeof OBR.player?.setMetadata === "function";
  let players = [], ready = false, board = null, changedAt = now(), generation = 0;
  const update = next => { players = Array.isArray(next) ? next : []; changedAt = now(); generation++; };
  if (supported) {
    OBR.party.onChange(update);
    const version = generation, roster = await OBR.party.getPlayers();
    if (generation === version) update(roster);
  }
  return {
    async ready(key) {
      if (!supported || board === key && ready) return;
      board = key; ready = true;
      await OBR.player.setMetadata({ [CONTROLLER_KEY]: { protocol: 1, board: key } });
      changedAt = now();
    },
    successor(snapshot) {
      if (!supported || !ready || !board || now() - changedAt < 0.6 || snapshot?.board !== board || snapshot.host === connection) return null;
      // Respect a live current host, including an older extension version.
      if (players.some(player => player.connectionId === snapshot.host && player.role === "GM")) return null;
      const candidates = [connection, ...players.filter(player => player.role === "GM" &&
        player.metadata?.[CONTROLLER_KEY]?.protocol === 1 && player.metadata[CONTROLLER_KEY].board === board)
        .map(player => player.connectionId)].filter(value => typeof value === "string" && value);
      return [...new Set(candidates)].sort()[0] ?? null;
    },
  };
}
