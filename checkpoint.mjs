import { newMatch } from "./rules.mjs?v=0.9.0";
import { lineupSlots } from "./classes.mjs?v=0.9.0";

// Public snapshots already contain health/claims/captures and combat views.
// Store only the missing simulation state, avoiding a second full match copy.
export function checkpoint(match) {
  const ids = match.board.slots.map(slot => slot.id), index = id => ids.indexOf(id);
  return {
    schema: 1, nextScore: match.nextScore, nextCombat: match.nextCombat,
    pawns: ids.map(id => { const p = match.pawns[id]; return [p.position.x, p.position.y,
      p.destination ? [p.destination.x, p.destination.y] : null, p.hp, Number.isFinite(p.lastCombatAt) ? p.lastCombatAt : null, Boolean(p.bot)]; }),
    pets: match.pets.map(p => [p.progress, p.pickup ?? null]),
    fights: [...match.points, ...match.pets].map(area => {
      const c = area.combat;
      return !c ? null : [c.startedAt, Object.entries(c.fighters).map(([id, f]) => [index(id), f.actions, f.missed]),
        c.inactive.map(index), [index(c.carriers.red), index(c.carriers.blue)]];
    }),
  };
}

export function restoreCheckpoint(board, snapshot) {
  const data = snapshot?.checkpoint;
  if (snapshot?.board !== board?.key || data?.schema !== 1 || !Array.isArray(data.pawns) ||
      data.pawns.length !== board.slots.length || !Array.isArray(data.pets) || data.pets.length !== board.pets.length ||
      !Array.isArray(data.fights) || data.fights.length !== board.points.length + board.pets.length ||
      !Array.isArray(snapshot.points) || snapshot.points.length !== board.points.length || !Array.isArray(snapshot.pets) ||
      !Number.isFinite(data.nextScore) || !Number.isSafeInteger(data.nextCombat) ||
      !Number.isFinite(snapshot.nextWave) || ![snapshot.score?.red, snapshot.score?.blue].every(Number.isFinite) ||
      !Number.isFinite(snapshot.elapsed) || !Number.isFinite(snapshot.routeSeconds) || snapshot.routeSeconds < 2 || snapshot.routeSeconds > 90 ||
      data.pets.some(row => !Array.isArray(row) || !Number.isFinite(row[0])) ||
      data.fights.some(seed => seed !== null && (!Array.isArray(seed) || !Number.isFinite(seed[0]) || !Array.isArray(seed[1]) ||
        !Array.isArray(seed[2]) || !Array.isArray(seed[3]) || seed[3].length !== 2))) return null;
  const slots = lineupSlots(board.slots, snapshot.classes), ids = slots.map(slot => slot.id);
  const match = newMatch({ ...board, slots }, snapshot.claims ?? {}, snapshot.routeSeconds, Boolean(snapshot.calibrated));
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i], row = data.pawns[i], visible = snapshot.pawns?.[id];
    if (!Array.isArray(row) || !row.slice(0, 2).every(Number.isFinite) || !Number.isFinite(row[3]) ||
        row[2] !== null && (!Array.isArray(row[2]) || row[2].length !== 2 || !row[2].every(Number.isFinite))) return null;
    Object.assign(match.pawns[id], { position: { x: row[0], y: row[1] }, destination: row[2] && { x: row[2][0], y: row[2][1] },
      hp: row[3], lastCombatAt: row[4] ?? -Infinity, bot: row[5], deadUntil: visible?.deadUntil ?? 0,
      pet: Boolean(visible?.pet), deathReason: visible?.deathReason ?? null, retreating: Boolean(visible?.retreating) });
  }
  Object.assign(match, { elapsed: snapshot.elapsed, score: { ...snapshot.score }, nextScore: data.nextScore,
    nextWave: snapshot.nextWave, nextCombat: data.nextCombat, stepSeconds: snapshot.actionSeconds === 1 ? 1 : 3,
    practice: Boolean(snapshot.practice), practiceOpponent: Boolean(snapshot.practiceOpponent),
    lastClash: snapshot.lastClash ?? null, winner: snapshot.winner ?? null });
  for (let i = 0; i < match.points.length; i++) Object.assign(match.points[i], snapshot.points[i]);
  for (let i = 0; i < match.pets.length; i++) Object.assign(match.pets[i], {
    available: Boolean(snapshot.pets[i]?.available), progress: data.pets[i][0], pickup: data.pets[i][1],
  });
  for (const [i, area] of [...match.points, ...match.pets].entries()) {
    const seed = data.fights[i];
    if (!seed) continue;
    const view = snapshot.combats?.find(c => c.name === area.name && c.kind === (i < match.points.length ? "point" : "pet"));
    if (!view || !Array.isArray(view.members) || !Array.isArray(view.ready) || !Array.isArray(view.totals) ||
        !Number.isFinite(view.endsAt) || seed[1].some(row => !Array.isArray(row) || !ids[row[0]] ||
          !Number.isSafeInteger(row[1]) || !Number.isSafeInteger(row[2]))) return null;
    const carriers = {};
    for (const [n, team] of ["red", "blue"].entries()) if (ids[seed[3][n]]) carriers[team] = ids[seed[3][n]];
    area.combat = { id: view.id, kind: view.kind, round: view.round, stepSeconds: view.stepSeconds,
      roundLimit: view.roundLimit, startedAt: seed[0], endsAt: view.endsAt, members: [...view.members],
      clicks: Object.fromEntries(view.ready.map(id => [id, true])), carriers,
      fighters: Object.fromEntries(seed[1].map(([n, actions, missed]) => [ids[n], { actions, missed }])),
      totals: [...view.totals], inactive: seed[2].map(n => ids[n]), history: view.previous ? [view.previous] : [] };
  }
  return match;
}
