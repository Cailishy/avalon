import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { inspectBoundaries } from "./check-boundaries.mjs";

describe("architecture boundaries", () => {
  it("keeps pure, state, view, and adapter seams free of forbidden dependencies", () => {
    const result = inspectBoundaries(fileURLToPath(new URL("../../", import.meta.url)));
    expect(result.errors).toEqual([]);
  });
});
