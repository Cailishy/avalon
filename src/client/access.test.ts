import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./icons", () => ({ icon: () => "" }));

beforeEach(() => {
  vi.stubGlobal("document", { querySelector: () => null });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function setup() {
  const { bindAccessForm } = await import("./access");
  let onSubmit: (event: { preventDefault: () => void }) => Promise<void>;
  let onInput: () => void;
  const button = { disabled: false, textContent: "进入游戏" };
  const input = { value: "keep-my-input", setAttribute: vi.fn(), removeAttribute: vi.fn(), focus: vi.fn(), addEventListener: vi.fn((_event, fn) => { onInput = fn; }) };
  const error = { textContent: "" };
  const form = { querySelector: () => button, setAttribute: vi.fn(), removeAttribute: vi.fn(), addEventListener: vi.fn((_event, fn) => { onSubmit = fn; }) };
  const root = { querySelector: (selector: string) => ({ "#access-form": form, "#access-code": input, "#access-error": error })[selector] };
  const submit = vi.fn();
  const enter = vi.fn();
  bindAccessForm(root as unknown as Document, submit, enter);
  return { input, button, error, form, submit, enter, send: () => onSubmit({ preventDefault: vi.fn() }), edit: () => onInput() };
}

describe("Entrance form", () => {
  it("submits only to the backend and enters only after a successful response", async () => {
    const ui = await setup();
    ui.submit.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    await ui.send();
    expect(ui.submit).toHaveBeenCalledWith("/api/access", expect.objectContaining({ method: "POST", credentials: "same-origin", body: JSON.stringify({ code: "keep-my-input" }) }));
    expect(ui.enter).toHaveBeenCalledOnce();
  });

  it.each([401, 429])("keeps the input on backend error %i and does not enter", async status => {
    const ui = await setup();
    ui.submit.mockResolvedValue({ ok: false, status, json: async () => ({ ok: false, error: "Server refusal" }) });
    await ui.send();
    expect(ui.error.textContent).toBe("Server refusal");
    expect(ui.input.value).toBe("keep-my-input");
    expect(ui.enter).not.toHaveBeenCalled();
    expect(ui.button.disabled).toBe(false);
    ui.edit();
    expect(ui.error.textContent).toBe("");
    expect(ui.input.removeAttribute).toHaveBeenCalledWith("aria-invalid");
  });

  it("does not trust an ok response body on a failed HTTP response", async () => {
    const ui = await setup();
    ui.submit.mockResolvedValue({ ok: false, json: async () => ({ ok: true }) });
    await ui.send();
    expect(ui.enter).not.toHaveBeenCalled();
  });

  it("rejects empty input without a request", async () => {
    const ui = await setup();
    ui.input.value = "  ";
    await ui.send();
    expect(ui.submit).not.toHaveBeenCalled();
    expect(ui.input.focus).toHaveBeenCalled();
  });

  it("prevents double submissions while verification is pending", async () => {
    const ui = await setup();
    let finish!: (value: unknown) => void;
    ui.submit.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = ui.send();
    expect(ui.button.disabled).toBe(true);
    await ui.send();
    expect(ui.submit).toHaveBeenCalledOnce();
    finish({ ok: true, json: async () => ({ ok: true }) });
    await first;
  });

  it("restores controls and preserves text after a network error", async () => {
    const ui = await setup();
    ui.submit.mockRejectedValue(new Error("offline"));
    await ui.send();
    expect(ui.error.textContent).toContain("无法连接");
    expect(ui.input.value).toBe("keep-my-input");
    expect(ui.button.disabled).toBe(false);
    expect(ui.enter).not.toHaveBeenCalled();
  });

  it("aborts a stalled verification after eight seconds", async () => {
    const ui = await setup();
    ui.submit.mockImplementation((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const pending = ui.send();
    await vi.advanceTimersByTimeAsync(8000);
    await pending;
    expect(ui.button.disabled).toBe(false);
    expect(ui.error.textContent).toContain("无法连接");
  });
});
