import { icon } from "./icons";
import "./table-theme.css";
import "./access.css";

export function bindAccessForm(root: Document, submit: typeof fetch, enter: () => void): void {
  const form = root.querySelector<HTMLFormElement>("#access-form");
  const input = root.querySelector<HTMLInputElement>("#access-code");
  const button = form?.querySelector<HTMLButtonElement>("button");
  const error = root.querySelector<HTMLElement>("#access-error");
  if (!form || !input || !button || !error) return;
  let pending = false;
  input.addEventListener("input", () => {
    error.textContent = "";
    input.removeAttribute("aria-invalid");
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (pending) return;
    if (!input.value.trim()) {
      error.textContent = "请输入入场暗号。";
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
    pending = true;
    button.disabled = true;
    button.textContent = "验证中…";
    form.setAttribute("aria-busy", "true");
    error.textContent = "";
    input.removeAttribute("aria-invalid");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await submit("/api/access", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: input.value }), signal: controller.signal,
      });
      const result: { ok?: boolean; error?: string } = await response.json();
      if (response.ok && result.ok === true) {
        enter();
        return;
      }
      error.textContent = result.error ?? "验证失败，请重试。";
      input.setAttribute("aria-invalid", "true");
      input.focus();
    } catch {
      error.textContent = "暂时无法连接服务器，请重试。";
    } finally {
      clearTimeout(timeout);
      pending = false;
      button.disabled = false;
      button.textContent = "进入游戏";
      form.removeAttribute("aria-busy");
    }
  });
}

const emblem = document.querySelector("#access-emblem");
if (emblem) emblem.innerHTML = icon("shield", 38);
bindAccessForm(document, fetch, () => {
  // Keep invitation parameters, but never leave the user on the standalone gate document.
  if (window.location.pathname === "/access.html") window.location.replace(`/${window.location.search}${window.location.hash}`);
  else window.location.reload();
});
