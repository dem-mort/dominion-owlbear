const PANEL_KEY = "ru.allods.dominion/help-view";
const guideUrl = new URL("./guide.svg?v=0.4.2", import.meta.url).href;
const blankUrl = new URL("./blank.svg", import.meta.url).href;
const COLORS = { text: "#e8f0f5", muted: "#a8bac8", red: "#ffb0aa", blue: "#9adeff", amber: "#ffd296", green: "#a7e2c4" };

function clock(seconds) {
  const value = Math.max(0, Math.ceil(Number(seconds) || 0));
  return Math.floor(value / 60) + ":" + String(value % 60).padStart(2, "0");
}

function pointStatus(state, name) {
  const point = state.points?.find(point => point.name === name);
  if (state.combats?.some(combat => combat.kind === "point" && combat.name === name)) return { text: "Оспаривается", color: COLORS.amber };
  if (point?.progress > 0) return { text: (point.team ? "Снятие " : "Захват ") + Math.min(10, Math.ceil(point.progress)) + "/10 с", color: COLORS.amber };
  return point?.team ? { text: point.team === "red" ? "Красные" : "Синие", color: COLORS[point.team] } : { text: "Свободна", color: COLORS.muted };
}

export function panelFields(state) {
  const playing = state.phase === "playing";
  const finished = state.phase === "finished";
  const status = finished ? state.winner === "draw" ? "Матч завершён · ничья" : "Победа " + (state.winner === "red" ? "красных" : "синих")
    : playing ? state.practice ? "Тренировка" : "Матч идёт" : "Лобби · " + Object.keys(state.claims ?? {}).length + "/12";
  const steps = playing ? [
    ["Выбери точку назначения", "Кнопка точки запускает бег."],
    ["Удерживай круг", "10 с без врагов. Чужую сначала сбей."],
    ["Следи за панелью боя", "Клик раз в 3 с. Можно отступить."],
  ] : finished ? [
    ["Посмотри итоговый счёт", "Победитель указан под счётом."],
    ["Вернись в лобби", "Кнопку возвращения нажимает ведущий."],
    ["Подготовь следующий матч", "Выбери состав и аспекты заново."],
  ] : [
    ["Открой панель «Доминион»", "Значок бегуна вверху слева."],
    ["Выбери фишку и её аспект", "Ведущий: кнопка «Начать матч»."],
    ["Нажми точку в панели", "Фишка побежит к выбранному кругу."],
  ];
  let pets = "Появятся через 30 с после старта";
  if (playing || finished) {
    const ready = (state.pets ?? []).filter(pet => pet.available && !pet.fighting).map(pet => pet.name);
    const fighting = (state.pets ?? []).filter(pet => pet.fighting).map(pet => pet.name);
    pets = ready.length ? "Готовы " + ready.join(", ") : state.nextWave < 720 ? "До новой волны " + clock(state.nextWave - state.elapsed) : "Новых волн не будет";
    if (fighting.length) pets += " · бой за " + fighting.join(", ");
  }
  const fields = [
    { id: "score-red", text: String(Math.max(0, Math.round(state.score?.red ?? 0))), x: 1088, y: 151, width: 110, height: 46, size: 34, weight: 700, color: COLORS.red },
    { id: "score-blue", text: String(Math.max(0, Math.round(state.score?.blue ?? 0))), x: 1234, y: 151, width: 110, height: 46, size: 34, weight: 700, color: COLORS.blue },
    { id: "status", text: status, x: 1076, y: 228, width: 158, height: 26, size: 12, weight: 600, color: finished ? COLORS[state.winner] ?? COLORS.text : COLORS.muted },
    { id: "timer", text: clock(720 - (state.elapsed ?? 0)), x: 1252, y: 226, width: 102, height: 31, size: 23, weight: 700, align: "RIGHT" },
    { id: "steps-title", text: playing ? "ЧТО ДЕЛАТЬ СЕЙЧАС" : finished ? "МАТЧ ЗАВЕРШЁН" : "КАК НАЧАТЬ", x: 1076, y: 286, width: 278, height: 22, size: 11, weight: 700, color: COLORS.muted },
    { id: "pets", text: pets, x: 1088, y: 677, width: 254, height: 24, size: 12, color: (state.pets ?? []).some(pet => pet.available && !pet.fighting) ? COLORS.green : COLORS.muted },
  ];
  for (const [index, step] of steps.entries()) {
    fields.push({ id: "step-" + index, text: step[0], x: 1110, y: 316 + index * 47, width: 244, height: 24, size: 13, weight: 650 });
    fields.push({ id: "step-help-" + index, text: step[1], x: 1110, y: 338 + index * 47, width: 244, height: 21, size: 11.5, color: COLORS.muted });
  }
  for (const [index, name] of ["Трефа", "Капля", "Звезда"].entries()) {
    const status = pointStatus(state, name);
    fields.push({ id: "point-" + index, text: status.text, x: 1190, y: 504 + index * 36, width: 150, height: 25, size: 12, align: "RIGHT", color: status.color });
  }
  return fields;
}

export function boardPanelViews(state, items) {
  if (!state || ["Трефа", "Капля", "Звезда"].map(name => items.find(item => item.layer === "PROP" && item.name === name)?.id).join("/") !== state.board) return [];
  const map = items.find(item => item.layer === "MAP" && item.name === "Осколок Силы · Карта");
  if (!map?.image) return [];
  const background = {
    ...map, name: "Доминион · Информация о матче", layer: "NOTE", zIndex: 1000,
    visible: true, locked: true, disableHit: true, textItemType: "TEXT",
    image: { ...map.image, url: guideUrl, mime: "image/svg+xml" },
    metadata: { [PANEL_KEY]: "background" },
    text: { type: "PLAIN", plainText: "", richText: [{ type: "paragraph", children: [{ text: "" }] }],
      width: map.image.width, height: map.image.height, style: { padding: 0, fontSize: 12, fillColor: COLORS.text, fillOpacity: 0, strokeWidth: 0 } },
  };
  delete background.attachedTo;
  const result = [{ source: PANEL_KEY, item: background }];
  const angle = (map.rotation ?? 0) * Math.PI / 180;
  const scale = map.scale ?? { x: 1, y: 1 };
  const offset = map.grid?.offset ?? { x: 0, y: 0 };
  const ratio = 150 / (map.grid?.dpi ?? 150);
  for (const [index, field] of panelFields(state).entries()) {
    const dx = (field.x - offset.x) * scale.x * ratio;
    const dy = (field.y - offset.y) * scale.y * ratio;
    const item = {
      ...background, name: "Доминион · " + field.id, zIndex: 1001 + index,
      image: { url: blankUrl, mime: "image/svg+xml", width: field.width, height: field.height },
      grid: { dpi: map.grid?.dpi ?? 150, offset: { x: 0, y: 0 } },
      position: { x: map.position.x + dx * Math.cos(angle) - dy * Math.sin(angle), y: map.position.y + dx * Math.sin(angle) + dy * Math.cos(angle) },
      metadata: { [PANEL_KEY]: field.id },
      text: { type: "PLAIN", plainText: field.text, richText: [{ type: "paragraph", children: [{ text: field.text }] }],
        width: field.width, height: field.height,
        style: { padding: 0, fontFamily: "Roboto", fontSize: field.size, fontWeight: field.weight ?? 400,
          textAlign: field.align ?? "LEFT", textAlignVertical: "MIDDLE", lineHeight: 1.1,
          fillColor: field.color ?? COLORS.text, fillOpacity: 1, strokeColor: "#000000", strokeOpacity: 0, strokeWidth: 0 } },
    };
    result.push({ source: PANEL_KEY + "/" + field.id, item });
  }
  return result;
}
