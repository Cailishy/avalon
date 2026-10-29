import { describe, expect, it } from "vitest";
import { minimumTableDiameter, tableLayout } from "./tableLayout";

describe("Responsive round table geometry", () => {
  for (const [width, height, seatWidth, seatHeight] of [[290, 290, 48, 58], [351, 351, 60, 72], [520, 520, 88, 100], [800, 600, 88, 100]]) {
    for (let count = 5; count <= 10; count++) {
      it(`fits ${count} seats inside ${width}x${height} without overlaps, with self at bottom`, () => {
        const { points } = tableLayout(count, width, height, seatWidth, seatHeight);
        expect(points).toHaveLength(count);
        expect(points[0].x).toBeCloseTo(width / 2);
        expect(points[0].y).toBeGreaterThan(height / 2);
        const radius = points[0].y - height / 2;
        points.forEach((point, index) => {
          expect(Math.hypot(point.x - width / 2, point.y - height / 2)).toBeCloseTo(radius);
          expect(point.x - seatWidth / 2).toBeGreaterThanOrEqual(0);
          expect(point.y - seatHeight / 2).toBeGreaterThanOrEqual(0);
          expect(point.x + seatWidth / 2).toBeLessThanOrEqual(width);
          expect(point.y + seatHeight / 2).toBeLessThanOrEqual(height);
          for (const other of points.slice(index + 1)) {
            const gap = seatWidth <= 60 ? 4 : 8;
            expect(Math.abs(point.x - other.x) >= seatWidth + gap - 0.01 || Math.abs(point.y - other.y) >= seatHeight + gap - 0.01).toBe(true);
          }
        });
      });
    }
  }
  it("keeps narrow and wide tables circular and exposes a minimum usable diameter", () => {
    expect(tableLayout(10, 351, 351, 60, 72).mode).toBe("circle");
    expect(minimumTableDiameter(10, 60, 72)).toBeLessThanOrEqual(351);
    expect(minimumTableDiameter(10, 48, 58)).toBeLessThanOrEqual(290);
    expect(tableLayout(0, 300, 500, 84, 106).points).toEqual([]);
  });
});
