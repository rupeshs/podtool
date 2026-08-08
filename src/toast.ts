import { icon } from "./icons";
import { escapeHtml } from "./format";

type ToastKind = "success" | "error";

export function toast(message: string, kind: ToastKind = "success"): void {
  const root = document.getElementById("toast-root");
  if (!root) return;

  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `
    <span class="toast-icon">${icon(kind === "success" ? "check" : "alert")}</span>
    <span>${escapeHtml(message)}</span>
  `;
  root.appendChild(el);

  window.setTimeout(() => {
    el.style.transition = "opacity 0.15s ease";
    el.style.opacity = "0";
    window.setTimeout(() => el.remove(), 160);
  }, 3400);
}
