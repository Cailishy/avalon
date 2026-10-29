import morphdom from "morphdom";

export function patchHtml(root: HTMLElement, html: string): void {
  const target = root.cloneNode(false) as HTMLElement;
  target.innerHTML = html;
  target.querySelectorAll<HTMLElement>(".modal-overlay").forEach(overlay => {
    overlay.dataset.renderKey = `dialog:${overlay.querySelector("h2")?.textContent ?? "modal"}`;
  });
  const commands = new Map<string, number>();
  target.querySelectorAll<HTMLElement>("button[data-action]").forEach(button => {
    const region = button.closest<HTMLElement>("[data-render-key]")?.dataset.renderKey ?? "entry";
    const key = `${region}:command:${button.dataset.action}`;
    const index = commands.get(key) ?? 0;
    commands.set(key, index + 1);
    button.dataset.renderKey = `${key}:${index}`;
  });
  morphdom(root, target, {
    childrenOnly: true,
    getNodeKey: node => node instanceof Element ? (node.getAttribute("data-render-key") ?? node.id) || undefined : undefined,
    onBeforeElUpdated(from, to) {
      if (from.matches(".player-seat")) {
        to.style.left = from.style.left;
        to.style.top = from.style.top;
      } else if (from.matches(".table-surface")) {
        to.style.minWidth = from.style.minWidth;
        if (from.dataset.layout) to.dataset.layout = from.dataset.layout;
      } else if (from.matches(".modal-overlay") && from.classList.contains("dialog-entering")) {
        to.classList.add("dialog-entering");
        to.style.setProperty("--dialog-offset", from.style.getPropertyValue("--dialog-offset"));
      }
      return !from.isEqualNode(to);
    },
  });
}

export class RenderEvents {
  private controller = new AbortController();
  get signal(): AbortSignal { return this.controller.signal; }
  reset(): void { this.controller.abort(); this.controller = new AbortController(); }
  listen<K extends keyof HTMLElementEventMap>(target: EventTarget | null | undefined, type: K, listener: (event: HTMLElementEventMap[K]) => void): void {
    target?.addEventListener(type, listener as EventListener, { signal: this.signal });
  }
}
