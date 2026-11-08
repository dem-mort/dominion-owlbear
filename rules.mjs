import { combatTick, combatForPawn, combatClick, defaultAspect, aspectOptions, MAX_HP } from "./combat.mjs?v=0.11.3";
export { combatForPawn, combatClick, combatViews, defaultAspect, aspectOptions, MAX_HP, ASPECTS, STEP_SECONDS, COMBAT_STEPS } from "./combat.mjs?v=0.11.3";
export const NS = "ru.allods.dominion";
export const TOTAL = 720;
export const TARGET = 1000;
export const TEAMS = ["red", "blue"];
export const TEAM_NAME = { red: "Красные", blue: "Синие", draw: "Ничья" };
export const POINT_NAMES = ["Трефа", "Капля", "Звезда"];
export const SLOT = /^[КС][1-6](?= · )/u;
export const WAVE_FIRST = 30;
export const WAVE_INTERVAL = 120;
// Preserve the prototype's mean rate (formerly 30 per 30 s), with a real
// one-second score pulse. The retail server coefficient is not in client Lua.
export const SCORE_STEP = 1;
export const POINT_SCORE = 1;





// Coordinates are in the reference board's units. Scale and translate against
// the native point props when opening the scene.
const RED = { x: 309, y: 438 };
const BLUE = { x: 559, y: 656 };
const DROP = { x: 523, y: 427 };
export const DEFAULT_ROUTE_SECONDS = 10;

// The no-opponent stage is twelve seconds. Applying the same normalized stage
// to neutralization is an explicit tabletop adaptation, not a live-client test.
export function captureRate(attackers, defenders) {
  if (attackers > 0 && defenders === 0) return 100 / 12;
  if (attackers === 0 && defenders > 0) return -100 / 12;
  if (attackers - defenders >= 2) return 100 / 30;
  if (defenders - attackers >= 2) return -100 / 30;
  return 0;
}

export function captureStatus(point) {
  if (!Number.isFinite(point?.progress) || point.progress <= 0) return "";
  const percent = Math.max(1, Math.min(100, Math.round(point.progress)));
  const action = point.captureRate < 0 ? "Откат" : point.team ? "Снятие" : "Захват";
  return action + " " + percent + "%";
}

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
    points: board.points.map(point => ({ ...point, team: null, progress: 0, capturing: null, captureRate: 0, clash: 0 })),
    pets: board.pets.map(pet => ({ ...pet, available: false, pickup: null, progress: 0 })),
    score: { red: 0, blue: 0 }, nextScore: SCORE_STEP, nextWave: WAVE_FIRST,
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

function advanceCapture(point, sides, elapsed) {
  let attacker = point.team ? point.team === "red" ? "blue" : "red" : point.capturing;
  if (!attacker) {
    if (captureRate(sides.red.length, sides.blue.length) > 0) attacker = "red";
    else if (captureRate(sides.blue.length, sides.red.length) > 0) attacker = "blue";
  }
  if (!attacker) { point.captureRate = 0; return; }
  const defender = attacker === "red" ? "blue" : "red";
  point.capturing = attacker;
  point.captureRate = captureRate(sides[attacker].length, sides[defender].length);
  point.progress = Math.max(0, Math.min(100, point.progress + point.captureRate * elapsed));
  if (point.progress >= 100 - 1e-8) {
    point.team = point.team ? null : attacker;
    point.progress = 0;
    point.capturing = point.team ? null : attacker;
  } else if (point.progress <= 1e-8) {
    point.progress = 0;
    point.capturing = null;
  }
}

export function tick(match, elapsed, die = () => 1 + Math.floor(Math.random() * 6)) {
  if (match.winner || !Number.isFinite(elapsed) || elapsed <= 0) return;
  let remaining = Math.min(elapsed, TOTAL - match.elapsed);
  while (remaining > 1e-8 && !match.winner) {
    // Do not credit a newly captured point retroactively for a large caller step.
    const step = Math.min(remaining, Math.max(1e-8, match.nextScore - match.elapsed));
    tickStep(match, step, die); remaining -= step;
  }
}

function tickStep(match, elapsed, die) {
  if (match.winner || elapsed <= 0) return;
  match.elapsed = Math.min(TOTAL, match.elapsed + elapsed);
  if (Math.abs(match.elapsed - match.nextScore) < 1e-8) match.elapsed = match.nextScore;
  if (TOTAL - match.elapsed < 1e-8) match.elapsed = TOTAL;
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
    combatTick(match, point, sides, "point", die);
    // Combat can remove dead participants on this tick. Capture uses the living
    // roster after resolution and continues during numerical superiority.
    advanceCapture(point, occupants(match, point), elapsed);
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
  if (match.elapsed >= match.nextScore - 1e-8) {
    match.nextScore += SCORE_STEP;
    for (const point of match.points) if (point.team) match.score[point.team] = Math.min(TARGET, match.score[point.team] + POINT_SCORE);
  }
  const { red, blue } = match.score;
  if (match.elapsed >= TOTAL || red >= TARGET || blue >= TARGET) {
    match.winner = red === blue ? "draw" : red > blue ? "red" : "blue";
  }
}
