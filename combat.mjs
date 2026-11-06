import { aspectOptions, defaultAspect } from "./classes.mjs?v=0.11.0";
export { aspectOptions, defaultAspect } from "./classes.mjs?v=0.11.0";
export const STEP_SECONDS = 3;
export const COMBAT_STEPS = 5;
export const MAX_HP = 100;
export const PET_DAMAGE_MULTIPLIER = 1.3;
export const ASPECTS = {
  attack: { name: "Аспект Нападения", short: "ДД", help: "Наносит основной урон", damage: 22, power: 1 },
  support: { name: "Аспект Поддержки", short: "САП", help: "Усиливает активных ДД рядом", damage: 8, power: 0.75 },
  heal: { name: "Аспект Исцеления", short: "ХИЛ", help: "Лечит раненых союзников", damage: 4, power: 0.8 },
  defense: { name: "Аспект Защиты", short: "ТАНК", help: "Получает на 35% меньше урона", damage: 12, power: 0.85 },
};
const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const allAreas = match => [...match.points, ...match.pets];
const allSides = sides => [...sides.red, ...sides.blue];
const factor = die => 0.4 + die() * 0.2;
function targetIndex(count, die) {
  const limit = Math.floor(6 / count) * count;
  let roll = die();
  // Uniform for every party size. Bound retries for deterministic test dice.
  for (let attempt = 0; roll > limit && attempt < 12; attempt++) roll = die();
  return (roll - 1) % count;
}

export function actionSeconds(match) {
  return match?.stepSeconds === 1 ? 1 : STEP_SECONDS;
}

export function defeat(match, pawn, reason) {
  pawn.hp = 0;
  pawn.deadUntil = match.elapsed + 25;
  pawn.destination = null;
  pawn.retreating = false;
  pawn.position = { ...match.board.spawn[pawn.team] };
  pawn.pet = false;
  pawn.deathReason = reason;
}

export function combatForPawn(match, id) {
  const pawn = match?.pawns[id];
  if (!pawn || pawn.deadUntil) return null;
  return allAreas(match).find(area => area.combat?.members.includes(id) && near(pawn.position, area.position) <= area.radius)?.combat ?? null;
}

export function combatClick(match, id, combatId, step) {
  if (!match || match.winner) return false;
  const combat = combatForPawn(match, id);
  if (!combat || combat.id !== combatId || combat.round !== step ||
      match.elapsed >= combat.endsAt - 1e-8 || combat.clicks[id]) return false;
  combat.clicks[id] = true;
  return true;
}

function openStep(match, combat, sides) {
  combat.endsAt = combat.startedAt + combat.round * combat.stepSeconds;
  combat.clicks = {};
  combat.members = allSides(sides).map(pawn => {
    if (!combat.fighters[pawn.id]) {
      combat.fighters[pawn.id] = { actions: 0, missed: 0 };
      pawn.destination = null;
    }
    return pawn.id;
  });
  match.combatRevision++;
}

function activeSupport(pawns, combat) {
  return Math.min(0.7, pawns.filter(pawn => pawn.aspect === "support" && combat.clicks[pawn.id]).length * 0.35);
}

function auraSources(combat, present, active = null) {
  const sources = {};
  for (const team of ["red", "blue"]) {
    const spent = present.find(pawn => pawn.team === team && pawn.id === combat.carriers[team]);
    const carrier = spent ?? present.find(pawn => pawn.team === team && pawn.pet);
    if (!carrier) continue;
    sources[team] = carrier.id;
    if (!spent && active?.some(pawn => pawn.team === team && pawn.aspect === "attack") &&
        present.some(pawn => pawn.team !== team)) {
      carrier.pet = false;
      combat.carriers[team] = carrier.id;
    }
  }
  return sources;
}

export function combatViews(match) {
  return allAreas(match).flatMap(area => {
    const combat = area.combat;
    if (!combat) return [];
    const present = Object.values(match.pawns).filter(pawn => pawn.claim && !pawn.deadUntil && near(pawn.position, area.position) <= area.radius);
    const members = combat.members.filter(id => present.some(pawn => pawn.id === id));
    const sources = auraSources(combat, present.filter(pawn => members.includes(pawn.id)));
    const counts = ["red", "blue"].map(team => Object.fromEntries(Object.keys(ASPECTS).map(aspect => [
      aspect, present.filter(pawn => pawn.team === team && pawn.aspect === aspect).length,
    ])));
    return [{
      id: combat.id, name: area.name, kind: combat.kind, round: combat.round, endsAt: combat.endsAt,
      position: { ...area.position }, radius: area.radius,
      stepSeconds: combat.stepSeconds, roundLimit: combat.roundLimit,
      totals: [...combat.totals], members, counts,
      numbers: [present.filter(pawn => pawn.team === "red").length, present.filter(pawn => pawn.team === "blue").length],
      ready: Object.keys(combat.clicks).filter(id => members.includes(id)),
      carriers: Object.values(sources),
      empowered: members.filter(id => match.pawns[id].aspect === "attack" && sources[match.pawns[id].team]),
      previous: combat.history.at(-1) ?? null,
    }];
  });
}

function finish(match, area, present, winner, reason, chance = null) {
  const combat = area.combat;
  const health = ["red", "blue"].map(team => Math.round(present.filter(pawn => pawn.team === team).reduce((sum, pawn) => sum + pawn.hp, 0)));
  for (const pawn of present) if (winner !== "draw" && pawn.team !== winner) defeat(match, pawn, "combat");
  match.lastClash = { point: area.name, kind: combat.kind, winner, totals: [...combat.totals], health,
    inactive: [...combat.inactive], rounds: combat.history, reason, chance };
  area.combat = null;
  match.combatRevision++;
}

export function combatTick(match, area, sides, kind, die) {
  if (!area.combat) {
    if (!sides.red.length || !sides.blue.length) return false;
    const stepSeconds = actionSeconds(match);
    area.combat = { id: area.id + "/" + ++match.nextCombat, kind, round: 1, stepSeconds, roundLimit: 15 / stepSeconds,
      startedAt: match.elapsed, fighters: {}, carriers: {}, history: [], totals: [0, 0], inactive: [] };
    openStep(match, area.combat, sides);
  }
  const combat = area.combat;
  const here = allSides(sides);
  combat.members = combat.members.filter(id => here.some(pawn => pawn.id === id));
  for (const pawn of here) pawn.lastCombatAt = match.elapsed;
  // Leaving takes effect on the simulation tick, including before the last throw.
  if (!sides.red.length || !sides.blue.length) {
    finish(match, area, here.filter(pawn => combat.members.includes(pawn.id)),
      !here.length ? "draw" : sides.red.length ? "red" : "blue", "retreat");
    return true;
  }
  if (match.elapsed < combat.endsAt - 1e-8) return true;

  const results = [];
  let present = here.filter(pawn => combat.members.includes(pawn.id));
  for (const pawn of present) {
    const fighter = combat.fighters[pawn.id];
    const clicked = Boolean(combat.clicks[pawn.id]);
    if (clicked) {
      fighter.actions++;
      fighter.missed = 0;
    } else fighter.missed++;
    if (fighter.missed >= 2 || (combat.round === combat.roundLimit && fighter.actions === 0)) {
      combat.inactive.push(pawn.id);
      defeat(match, pawn, "inactive");
    }
    results.push({ id: pawn.id, team: pawn.team, aspect: pawn.aspect, active: clicked, missed: fighter.missed, damage: 0, healing: 0, boost: 0, pet: false });
  }
  present = present.filter(pawn => !pawn.deadUntil);
  const active = present.filter(pawn => combat.clicks[pawn.id]);
  const sources = auraSources(combat, present, active);
  const effectScale = combat.stepSeconds / STEP_SECONDS;
  const support = Object.fromEntries(["red", "blue"].map(team => [team, activeSupport(active.filter(pawn => pawn.team === team), combat)]));
  const incoming = Object.fromEntries(present.map(pawn => [pawn.id, 0]));
  const healing = Object.fromEntries(present.map(pawn => [pawn.id, 0]));
  for (const pawn of active) {
    const enemies = present.filter(other => other.team !== pawn.team);
    if (!enemies.length) continue;
    const result = results.find(result => result.id === pawn.id);
    result.pet = pawn.aspect === "attack" && Boolean(sources[pawn.team]);
    const target = enemies[targetIndex(enemies.length, die)];
    const damage = ASPECTS[pawn.aspect].damage * effectScale * factor(die) * (result.pet ? PET_DAMAGE_MULTIPLIER : 1) * (pawn.aspect === "attack" ? 1 + support[pawn.team] : 1) * (target.aspect === "defense" ? 0.65 : 1);
    incoming[target.id] += damage;
    result.damage = Math.round(damage);
    if (pawn.aspect === "support" && active.some(other => other.team === pawn.team && other.aspect === "attack")) result.boost = Math.round(support[pawn.team] * 100);
  }
  for (const pawn of active.filter(pawn => pawn.aspect === "heal")) {
    const allies = present.filter(other => other.team === pawn.team);
    const target = allies.reduce((lowest, other) =>
      other.hp - incoming[other.id] + healing[other.id] < lowest.hp - incoming[lowest.id] + healing[lowest.id] ? other : lowest);
    const amount = Math.min(MAX_HP - target.hp + incoming[target.id] - healing[target.id], 22 * effectScale * factor(die));
    healing[target.id] += Math.max(0, amount);
    results.find(result => result.id === pawn.id).healing = Math.round(Math.max(0, amount));
  }
  for (const pawn of present) {
    pawn.hp = Math.max(0, Math.min(MAX_HP, pawn.hp - incoming[pawn.id] + healing[pawn.id]));
    if (pawn.hp <= 1e-8) defeat(match, pawn, "combat");
  }
  const totals = ["red", "blue"].map(team => results.filter(result => result.team === team).reduce((sum, result) => sum + result.damage, 0));
  combat.totals = combat.totals.map((total, index) => total + totals[index]);
  combat.history.push({ round: combat.round, results, totals });
  const survivors = present.filter(pawn => !pawn.deadUntil);
  const red = survivors.filter(pawn => pawn.team === "red");
  const blue = survivors.filter(pawn => pawn.team === "blue");
  if (!red.length || !blue.length) {
    finish(match, area, survivors, !survivors.length ? "draw" : red.length ? "red" : "blue", "elimination");
  } else if (combat.round === combat.roundLimit) {
    // Random final throw, weighted by the CURRENT survivors, health and aspects.
    const weights = [red, blue].map(group => group.reduce((sum, pawn) => sum + pawn.hp * ASPECTS[pawn.aspect].power *
      (combat.clicks[pawn.id] ? 1 : 0.35) *
      (pawn.aspect === "attack" ? 1 + support[pawn.team] : 1), 0));
    const chance = weights[0] / (weights[0] + weights[1]);
    const ticket = ((die() - 1) * 6 + die() - 0.5) / 36;
    finish(match, area, survivors, ticket < chance ? "red" : "blue", "random", [Math.round(chance * 100), Math.round((1 - chance) * 100)]);
  } else {
    combat.round++;
    const nextSides = Object.fromEntries(["red", "blue"].map(team => [team, here.filter(pawn => pawn.team === team && !pawn.deadUntil)]));
    openStep(match, combat, nextSides);
  }
  return true;
}
