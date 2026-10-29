export type SeatPoint = { x: number; y: number };

const padding = 6;
const seatGap = (seatWidth: number) => seatWidth <= 60 ? 4 : 8;

export function minimumTableDiameter(count: number, seatWidth: number, seatHeight: number): number {
  const gap = seatGap(seatWidth);
  const sideCount = Math.ceil(Math.max(0, count - 2) / 2);
  const outerY = Math.max(0, sideCount - 1) * (seatHeight + gap) / 2;
  return Math.ceil(2 * Math.hypot(outerY, seatWidth + gap) + Math.max(seatWidth, seatHeight) + padding * 2);
}

export function tableLayout(count: number, width: number, height: number, seatWidth: number, seatHeight: number): { mode: "circle"; points: SeatPoint[] } {
  if (count < 1) return { mode: "circle", points: [] };
  const radius = Math.max(0, (Math.min(width, height) - Math.max(seatWidth, seatHeight)) / 2 - padding);
  const gap = seatGap(seatWidth);
  const points = Array.from({ length: count }, (_, i) => {
    const angle = Math.PI / 2 + i * Math.PI * 2 / count;
    return { x: width / 2 + radius * Math.cos(angle), y: height / 2 + radius * Math.sin(angle) };
  });
  const collides = points.some((point, i) => points.slice(i + 1).some((other) =>
    Math.abs(point.x - other.x) < seatWidth + gap && Math.abs(point.y - other.y) < seatHeight + gap));
  if (!collides || count <= 2) return { mode: "circle", points };

  // Adjust crowded seat angles while keeping every center on the same circle.
  const left = Math.floor((count - 2) / 2);
  const right = count - 2 - left;
  const sidePoints = (total: number, side: -1 | 1) => Array.from({ length: total }, (_, i) => {
    const y = (i - (total - 1) / 2) * (seatHeight + gap) * side;
    const x = side * Math.sqrt(Math.max(0, radius * radius - y * y));
    return { x: width / 2 + x, y: height / 2 + y };
  });
  return { mode: "circle", points: [
    { x: width / 2, y: height / 2 + radius },
    ...sidePoints(left, -1),
    { x: width / 2, y: height / 2 - radius },
    ...sidePoints(right, 1),
  ] };
}
