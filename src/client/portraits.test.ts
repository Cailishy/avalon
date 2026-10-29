import { describe, expect, it } from "vitest";
import { portraitMarkup, rolePortraitCell, seatPortraitCell, seatPortraitMarkup } from "./portraits";
import { ROLE_DEFS, type RoleKey } from "../shared/game";

describe("Portrait atlas mapping", () => {
  it("provides a unique atlas cell for every role", () => {
    const cells = (Object.keys(ROLE_DEFS) as RoleKey[]).map(role => rolePortraitCell(role));
    expect(new Set(cells).size).toBe(8);
    expect([...cells].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
  it("provides ten distinct public seat portraits independently of roles", () => {
    expect(new Set(Array.from({ length: 10 }, (_, i) => seatPortraitCell(i))).size).toBe(10);
    expect(seatPortraitCell(0)).toBe(0);
  });
  it("uses a separate neutral atlas for all public seats", () => {
    for (let seat = 0; seat < 10; seat++) {
      expect(seatPortraitMarkup(seat)).toContain("public-portrait");
      expect(seatPortraitMarkup(seat)).not.toContain("portrait-guest");
    }
    expect(seatPortraitMarkup(9)).toContain("--portrait-x:100%;--portrait-y:100%");
    expect(portraitMarkup(rolePortraitCell("merlin"))).not.toContain("portrait-guest");
  });
  it("provides stable male and female servant art without changing any other role", () => {
    expect(rolePortraitCell("servant", "male")).toBe(2);
    expect(rolePortraitCell("servant", "female")).toBe(8);
    expect(rolePortraitCell("servant", null)).toBe(2);
    expect(rolePortraitCell("servant")).toBe(2);
    expect(portraitMarkup(rolePortraitCell("servant", "female"))).toContain("portrait-guest");
    expect(rolePortraitCell("merlin", "female")).toBe(rolePortraitCell("merlin", "male"));
  });
});
