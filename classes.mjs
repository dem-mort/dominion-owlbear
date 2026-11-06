// Playable classes and their actual aspects; numerical effects are tabletop balance.
export const CLASSES = {
  warrior: { name: "Воин", short: "ВОИН", aspects: ["attack", "defense"] },
  paladin: { name: "Храмовник", short: "ХРАМ", aspects: ["attack", "defense"] },
  scout: { name: "Разведчик", short: "РАЗВ", aspects: ["attack", "defense"] },
  priest: { name: "Жрец", short: "ЖРЕЦ", aspects: ["attack", "support", "heal"], default: "heal" },
  mage: { name: "Маг", short: "МАГ", aspects: ["attack", "support"] },
  warden: { name: "Язычник", short: "ЯЗЫЧ", aspects: ["attack", "support", "heal"] },
  summoner: { name: "Некромант", short: "НЕКР", aspects: ["attack", "support", "heal"] },
  psionic: { name: "Мистик", short: "МИСТ", aspects: ["attack", "support"] },
  bard: { name: "Бард", short: "БАРД", aspects: ["attack", "support"], default: "support" },
  engineer: { name: "Инженер", short: "ИНЖ", aspects: ["attack", "support"] },
  demonologist: { name: "Демонолог", short: "ДЕМ", aspects: ["attack", "defense"] },
};
const names = new Map(Object.entries(CLASSES).map(([id, value]) => [value.name, id]));
for (const [name, id] of [["Волшебник", "mage"], ["Паладин", "paladin"], ["Друид", "warden"], ["Шаман", "warden"]]) names.set(name, id);
export function classId(slot) {
  return Object.hasOwn(CLASSES, slot?.classId) ? slot.classId : names.get(slot?.name?.split(" · ")[1]) ?? "warrior";
}
export const aspectOptions = slot => CLASSES[classId(slot)].aspects;
export const defaultAspect = slot => CLASSES[classId(slot)].default ?? "attack";
export function classTemplate(items, slot) {
  const choices = items.filter(item => item.layer === "CHARACTER" && classId(item) === classId(slot));
  return choices.find(item => item.id === slot.id) ?? choices.find(item => item.name[0] === slot.name[0]) ?? choices[0];
}
export function lineupSlots(slots, classes = {}) {
  return slots.map(slot => {
    const id = Object.hasOwn(CLASSES, classes[slot.id]) ? classes[slot.id] : classId(slot);
    return { ...slot, classId: id, baseClassId: slot.baseClassId ?? classId(slot), name: slot.name.slice(0, 2) + " · " + CLASSES[id].name };
  });
}
