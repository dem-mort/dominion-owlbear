import { combatTick, combatForPawn, combatClick, defaultAspect, aspectOptions, MAX_HP } from "./combat.mjs?v=0.4.0";
export { combatForPawn, combatClick, combatViews, defaultAspect, aspectOptions, MAX_HP, ASPECTS, STEP_SECONDS, COMBAT_STEPS } from "./combat.mjs?v=0.4.0";
export const NS = "ru.allods.dominion";
export const TOTAL = 720;
export const TARGET = 1000;
export const TEAMS = ["red", "blue"];
export const TEAM_NAME = { red: "Красные", blue: "Синие", draw: "Ничья" };
export const POINT_NAMES = ["Трефа", "Капля", "Звезда"];
export const SLOT = /^[КС][1-6](?= · )/u;
export const WAVE_FIRST = 30;
export const WAVE_INTERVAL = 120;





// Coordinates are in the reference board's units. Scale and translate against
// the native point props when opening the scene.
const RED = { x: 309, y: 438 };
const BLUE = { x: 559, y: 656 };
const DROP = { x: 523, y: 427 };
export const DEFAULT_ROUTE_SECONDS = 10;

export function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function advance(from, to, speed, elapsed) {
  const length = distance(from, to);
  const step = speed * elapsed;
  if (length <= step) return { ...to };
  return { x: from.x + (to.x - from.x) * step / length, y: from.y + (to.y - from.y) * step / length };
}

export function readBoard(items) {
  const points = POINT_NAMES.map(name => items.find(item => item.layer === "PROP" && item.name === name));
  const pets = [1, 2, 3].map(n => items.find(item => item.layer === "PROP" && item.name.startsWith("Б" + n + " · Баф питомца")));
  const scores = TEAMS.map(team => items.find(item => item.layer === "PROP" && item.name === "Счёт · " + TEAM_NAME[team]));
  const slots = items.filter(item => item.layer === "CHARACTER" && SLOT.test(item.name));
  if ([...points, ...pets, ...scores].some(item => !item) || new Set(slots.map(item => item.name.match(SLOT)[0])).size !== 12 || slots.length !== 12) return null;
  const scale = distance(points[1].position, points[2].position) / distance(DROP, { x: 703, y: 379 });
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const at = p => ({
    x: points[1].position.x + (p.x - DROP.x) * scale,
    y: points[1].position.y + (p.y - DROP.y) * scale,
  });
  return {
    key: points.map(point => point.id).join("/"),
    scale,
    points: points.map(({ id, name, position }) => ({ id, name, position, radius: 36 * scale })),
    pets: pets.map(({ id, position }, index) => ({ id, name: "Б" + (index + 1), position, radius: 22 * scale })),
    scores: scores.map(item => item.id),
    slots: slots.map(({ id, name, position, locked }) => ({ id, name, position, locked: Boolean(locked), team: name.startsWith("К") ? "red" : "blue" })).sort((a, b) => a.name.localeCompare(b.name, "ru")),
    spawn: { red: at(RED), blue: at(BLUE) },
    bounds: { min: at({ x: 244, y: 119 }), max: at({ x: 809, y: 696 }) },
  };
}

export function newMatch(board, claims, routeSeconds, calibrated) {
  const pawns = {};
  for (const slot of board.slots) {
    const index = Number(slot.name[1]) - 1;
    const spawn = board.spawn[slot.team];
    const chosenAspect = claims[slot.id]?.aspect ?? defaultAspect(slot);
    pawns[slot.id] = {
      ...slot,
      position: { x: spawn.x + (index % 3 - 1) * 19 * board.scale, y: spawn.y + (index < 3 ? -10 : 10) * board.scale },
      claim: claims[slot.id] || null,
      destination: null, deadUntil: 0, pet: false, deathReason: null,
      hp: MAX_HP, lastCombatAt: -Infinity, retreating: false,
      aspect: aspectOptions(slot).includes(chosenAspect) ? chosenAspect : defaultAspect(slot),
    };
  }
  return {
    board, pawns, routeSeconds, calibrated, elapsed: 0,
    speed: distance(board.spawn.red, board.points[1].position) / routeSeconds,
    points: board.points.map(point => ({ ...point, team: null, progress: 0, capturing: null, clash: 0 })),
    pets: board.pets.map(pet => ({ ...pet, available: false, pickup: null, progress: 0 })),
    score: { red: 0, blue: 0 }, nextScore: 30, nextWave: WAVE_FIRST,
    nextCombat: 0, combatRevision: 0,
    lastClash: null, winner: null,
  };
}

function occupants(match, area) {
  const sides = { red: [], blue: [] };
  for (const pawn of Object.values(match.pawns)) {
    if (pawn.claim && !pawn.deadUntil && distance(pawn.position, area.position) <= area.radius) {
      sides[pawn.team].push(pawn);
    }
  }
  return sides;
}

export function tick(match, elapsed, die = () => 1 + Math.floor(Math.random() * 6)) {
  if (match.winner || elapsed <= 0) return;
  match.elapsed = Math.min(TOTAL, match.elapsed + elapsed);
  for (const pawn of Object.values(match.pawns)) {
    if (pawn.deadUntil && match.elapsed >= pawn.deadUntil) { pawn.deadUntil = 0; pawn.deathReason = null; pawn.hp = MAX_HP; }
    if (match.practice && pawn.bot && !pawn.deadUntil && !pawn.destination && !combatForPawn(match, pawn.id) &&
        distance(pawn.position, match.points[1].position) > 0.1) pawn.destination = { ...match.points[1].position };
    if (!pawn.deadUntil && pawn.destination) {
      pawn.position = advance(pawn.position, pawn.destination, match.speed, elapsed);
      if (distance(pawn.position, pawn.destination) < 0.01) { pawn.destination = null; pawn.retreating = false; }
    }
    if (!pawn.deadUntil && !combatForPawn(match, pawn.id) && match.elapsed - pawn.lastCombatAt >= 5) pawn.hp = Math.min(MAX_HP, pawn.hp + 8 * elapsed);
  }
  for (const point of match.points) {
    const sides = occupants(match, point);
    if (combatTick(match, point, sides, "point", die)) continue;
    const team = sides.red.length ? "red" : sides.blue.length ? "blue" : null;
    if (!team || team === point.team || point.capturing !== team) {
      point.progress = 0;
      point.capturing = team;
    }
    if (!team || team === point.team) continue;
    point.progress += elapsed;
    if (point.progress >= 10) {
      point.team = point.team ? null : team;
      point.progress = 0;
    }
  }
  if (match.elapsed >= match.nextWave) {
    match.nextWave += WAVE_INTERVAL;
    for (const pet of match.pets) pet.available = true;
  }
  for (const pet of match.pets) {
    const sides = occupants(match, pet);
    if (combatTick(match, pet, sides, "pet", die)) { pet.progress = 0; pet.pickup = null; continue; }
    if (!pet.available) continue;
    const candidate = sides.red.length && sides.blue.length
      ? null : [...sides.red, ...sides.blue].find(pawn => !pawn.pet);
    if (!candidate || candidate.id !== pet.pickup) {
      pet.progress = 0;
      pet.pickup = candidate?.id ?? null;
    }
    if (!candidate) continue;
    pet.progress += elapsed;
    if (pet.progress >= 5) {
      candidate.pet = true;
      pet.available = false;
      pet.pickup = null;
      pet.progress = 0;
    }
  }
  if (match.practice) {
    for (const pawn of Object.values(match.pawns).filter(pawn => pawn.bot)) {
      const combat = combatForPawn(match, pawn.id);
      if (combat && match.elapsed >= combat.endsAt - 1.5) combatClick(match, pawn.id, combat.id, combat.round);
    }
  }
  if (match.elapsed >= match.nextScore) {
    match.nextScore += 30;
    for (const point of match.points) if (point.team) match.score[point.team] += 30;
  }
  const { red, blue } = match.score;
  if (match.elapsed >= TOTAL || red >= TARGET || blue >= TARGET) {
    match.winner = red === blue ? "draw" : red > blue ? "red" : "blue";
  }
}
