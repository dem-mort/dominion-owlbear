const GOLD = "#d9c9a5", DARK = "#172a36", RED = "#ffb0aa", BLUE = "#9adeff";
export function mapFields() {
  const labels = [
    ["trefoil", "Трефа", 500, 168, 62, 25, GOLD], ["drop", "Капля", 493, 370, 60, 25, GOLD], ["star", "Звезда", 671, 321, 64, 25, GOLD],
    ["spawn-red", "РЕСП КРАСНЫХ", 247, 467, 125, 25, RED], ["spawn-blue", "РЕСП СИНИХ", 506, 685, 107, 25, BLUE],
    ["pet-1", "Б1", 394, 283, 28, 25, "#ffd296"], ["pet-2", "Б2", 417, 493, 28, 25, "#ffd296"], ["pet-3", "Б3", 618, 481, 28, 25, "#ffd296"],
    ["team-red", "КРАСНЫЕ", 62, 307, 170, 25, RED], ["team-blue", "СИНИЕ", 686, 702, 170, 25, BLUE],
  ];
  return labels.map(([id, text, x, y, width, height, color]) => ({ id: "map-" + id, text, x, y, width, height, color,
    layer: "PROP", size: id.startsWith("team-") ? 14 : 12, weight: 700, align: id.startsWith("team-") ? "LEFT" : "CENTER" }));
}

export function mapPaths(state, Command) {
  const { MOVE: M, LINE: L, CUBIC: C, CLOSE: Z } = Command;
  const style = (fill, stroke = GOLD, width = 1.3, opacity = 1) => ({ fillColor: fill, fillOpacity: opacity, strokeColor: stroke, strokeOpacity: width ? 1 : 0, strokeWidth: width, strokeDash: [] });
  const rectangle = (x, y, w, h, r = 3) => [[M, x + r, y], [L, x + w - r, y], [L, x + w, y + r], [L, x + w, y + h - r], [L, x + w - r, y + h], [L, x + r, y + h], [L, x, y + h - r], [L, x, y + r], [Z]];
  const circle = (x, y, r) => { const k = r * .55228475; return [[M, x, y - r], [C, x + k, y - r, x + r, y - k, x + r, y], [C, x + r, y + k, x + k, y + r, x, y + r], [C, x - k, y + r, x - r, y + k, x - r, y], [C, x - r, y - k, x - k, y - r, x, y - r], [Z]]; };
  const polygon = points => [[M, ...points[0]], ...points.slice(1).map(point => [L, ...point]), [Z]];
  const paths = [
    { id: "map-red-roster", commands: rectangle(47, 298, 212, 168, 12), style: style(DARK, RED) },
    { id: "map-blue-roster", commands: rectangle(670, 692, 212, 168, 12), style: style(DARK, BLUE) },
  ];
  for (const label of mapFields().filter(field => !field.id.startsWith("map-team-"))) paths.push({ id: label.id + "-plate", commands: rectangle(label.x - 1, label.y - 1, label.width + 2, label.height + 2), style: style(DARK, label.color, .8) });
  const points = [{ name: "Трефа", x: 531, y: 226 }, { name: "Капля", x: 523, y: 427 }, { name: "Звезда", x: 703, y: 379 }];
  for (const [index, point] of points.entries()) {
    const owner = state.points?.find(item => item.name === point.name)?.team;
    const color = owner === "red" ? RED : owner === "blue" ? BLUE : GOLD;
    paths.push({ id: "map-point-ring-" + index, commands: circle(point.x, point.y, 36), style: style("#283c40", color, 2, .96) });
    let commands;
    if (index === 0) commands = [...circle(point.x, point.y - 8, 8), ...circle(point.x - 7, point.y + 3, 8), ...circle(point.x + 7, point.y + 3, 8), ...polygon([[point.x, point.y + 2], [point.x + 6, point.y + 17], [point.x - 6, point.y + 17]])];
    if (index === 1) commands = [[M, point.x, point.y - 17], [C, point.x - 3, point.y - 7, point.x - 12, point.y + 1, point.x - 12, point.y + 7], [C, point.x - 12, point.y + 22, point.x + 12, point.y + 22, point.x + 12, point.y + 7], [C, point.x + 12, point.y + 1, point.x + 3, point.y - 7, point.x, point.y - 17], [Z]];
    if (index === 2) commands = polygon(Array.from({ length: 10 }, (_, n) => { const a = -Math.PI / 2 + n * Math.PI / 5, r = n % 2 ? 8 : 18; return [point.x + Math.cos(a) * r, point.y + Math.sin(a) * r]; }));
    paths.push({ id: "map-point-icon-" + index, commands, style: style(GOLD, "#735b43", .8) });
  }
  return paths;
}
