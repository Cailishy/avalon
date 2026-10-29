import { describe, expect, it } from "vitest";
import { RenderEvents } from "./domRenderer";

describe("Stable-node event lifecycle", () => {
  it("removes previous render listeners before rebinding retained nodes", () => {
    const events = new RenderEvents(); const button = new EventTarget(); let clicks = 0;
    events.listen(button, "click", () => clicks++);
    events.reset(); events.listen(button, "click", () => clicks += 10);
    button.dispatchEvent(new Event("click")); expect(clicks).toBe(10);
    events.reset(); button.dispatchEvent(new Event("click")); expect(clicks).toBe(10);
  });
});
