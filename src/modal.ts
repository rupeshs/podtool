import { icon, mountIcons } from "./icons";
import { errMessage } from "./api";
import { escapeHtml } from "./format";
import { toast } from "./toast";

export interface ModalHandle {
  close: () => void;
  root: HTMLElement;
}

export function openModal(opts: {
  title: string;
  bodyHtml: string;
  footerHtml?: string;
  wide?: boolean;
  maximizable?: boolean;
  onClose?: () => void;
}): ModalHandle {
  const container = document.getElementById("modal-root")!;
  container.innerHTML = "";

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal ${opts.wide ? "wide" : ""}">
      <div class="modal-header">
        <h2>${opts.title}</h2>
        <div class="modal-header-actions">
          ${
            opts.maximizable
              ? `<button class="modal-header-btn" data-act="maximize" type="button" aria-label="Maximize">${icon("maximize")}</button>`
              : ""
          }
          <button class="modal-header-btn" data-act="close" type="button" aria-label="Close">${icon("x")}</button>
        </div>
      </div>
      <div class="modal-body">${opts.bodyHtml}</div>
      ${opts.footerHtml ? `<div class="modal-footer">${opts.footerHtml}</div>` : ""}
    </div>
  `;
  container.appendChild(overlay);
  mountIcons(overlay);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    container.innerHTML = "";
    opts.onClose?.();
  };

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }
  document.addEventListener("keydown", onKey);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector('[data-act="close"]')?.addEventListener("click", close);

  const maximizeBtn = overlay.querySelector<HTMLButtonElement>('[data-act="maximize"]');
  if (maximizeBtn) {
    let maximized = false;
    maximizeBtn.addEventListener("click", () => {
      maximized = !maximized;
      overlay.querySelector(".modal")?.classList.toggle("is-maximized", maximized);
      maximizeBtn.setAttribute("aria-label", maximized ? "Restore" : "Maximize");
      maximizeBtn.innerHTML = icon(maximized ? "minimize" : "maximize");
    });
  }

  return { close, root: overlay };
}

export function confirmDialog(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: boolean) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const footerHtml = `
      <button class="btn" data-act="cancel" type="button">Cancel</button>
      <button class="btn ${opts.danger ? "danger" : "primary"}" data-act="confirm" type="button">${opts.confirmLabel ?? "Confirm"}</button>
    `;

    const { close, root } = openModal({
      title: opts.title,
      bodyHtml: `<p>${opts.message}</p>`,
      footerHtml,
      onClose: () => settle(false),
    });

    root.querySelector('[data-act="cancel"]')?.addEventListener("click", () => {
      settle(false);
      close();
    });
    root.querySelector('[data-act="confirm"]')?.addEventListener("click", () => {
      settle(true);
      close();
    });
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function openLogsModal(title: string, fetchLogs: () => Promise<string>): void {
  const bodyHtml = `
    <div class="logs-toolbar">
      <label class="search logs-search" for="logs-search-input">
        <span class="search-icon" data-icon="search"></span>
        <input id="logs-search-input" type="text" placeholder="Search logs&hellip;" autocomplete="off" />
      </label>
      <span class="logs-match-count" id="logs-match-count"></span>
      <button class="icon-btn" id="logs-search-prev" type="button" title="Previous match" disabled>
        <span data-icon="chevronUp"></span>
      </button>
      <button class="icon-btn" id="logs-search-next" type="button" title="Next match" disabled>
        <span data-icon="chevronDown"></span>
      </button>
    </div>
    <div class="logs-output" id="logs-output">Loading&hellip;</div>
  `;
  const footerHtml = `
    <button class="btn" data-act="copy" type="button"><span data-icon="copy"></span> Copy logs</button>
    <button class="btn" data-act="refresh" type="button">Refresh</button>
  `;
  const { root } = openModal({ title, bodyHtml, footerHtml, wide: true, maximizable: true });
  mountIcons(root);

  const out = root.querySelector<HTMLElement>("#logs-output")!;
  const searchInput = root.querySelector<HTMLInputElement>("#logs-search-input")!;
  const matchCountEl = root.querySelector<HTMLElement>("#logs-match-count")!;
  const prevBtn = root.querySelector<HTMLButtonElement>("#logs-search-prev")!;
  const nextBtn = root.querySelector<HTMLButtonElement>("#logs-search-next")!;

  let rawText = "";
  let matchCount = 0;
  let currentMatch = -1;

  const render = () => {
    const query = searchInput.value.trim();
    if (!query) {
      out.textContent = rawText.trim() ? rawText : "(no output)";
      matchCount = 0;
      currentMatch = -1;
      matchCountEl.textContent = "";
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      return;
    }

    const re = new RegExp(escapeRegExp(query), "gi");
    let i = 0;
    out.innerHTML = escapeHtml(rawText).replace(re, (m) => `<mark class="log-mark" data-idx="${i++}">${m}</mark>`);
    matchCount = i;
    currentMatch = matchCount > 0 ? 0 : -1;
    prevBtn.disabled = matchCount === 0;
    nextBtn.disabled = matchCount === 0;
    updateMatchCount();
    focusCurrentMatch();
  };

  const updateMatchCount = () => {
    matchCountEl.textContent = matchCount === 0 ? "No matches" : `${currentMatch + 1} / ${matchCount}`;
  };

  const focusCurrentMatch = () => {
    out.querySelectorAll(".log-mark.is-current").forEach((el) => el.classList.remove("is-current"));
    if (currentMatch < 0) return;
    const el = out.querySelector<HTMLElement>(`.log-mark[data-idx="${currentMatch}"]`);
    el?.classList.add("is-current");
    el?.scrollIntoView({ block: "center" });
  };

  const goToMatch = (delta: number) => {
    if (matchCount === 0) return;
    currentMatch = (currentMatch + delta + matchCount) % matchCount;
    updateMatchCount();
    focusCurrentMatch();
  };

  searchInput.addEventListener("input", render);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      goToMatch(e.shiftKey ? -1 : 1);
    }
  });
  prevBtn.addEventListener("click", () => goToMatch(-1));
  nextBtn.addEventListener("click", () => goToMatch(1));

  const load = async () => {
    out.textContent = "Loading…";
    try {
      rawText = await fetchLogs();
      render();
      out.scrollTop = out.scrollHeight;
    } catch (e) {
      rawText = "";
      out.textContent = `Failed to load logs: ${errMessage(e)}`;
    }
  };

  root.querySelector('[data-act="refresh"]')?.addEventListener("click", load);
  root.querySelector('[data-act="copy"]')?.addEventListener("click", async () => {
    if (!rawText.trim()) {
      toast("No logs to copy", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(rawText);
      toast("Logs copied");
    } catch (e) {
      toast(`Couldn't copy logs: ${errMessage(e)}`, "error");
    }
  });
  void load();
}

function formatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/**
 * Shows a `podman ... inspect` result as a summary (built by the caller,
 * since the useful fields differ per resource type) with the full raw JSON
 * available behind a toggle for anything the summary doesn't cover.
 */
export function openInspectModal(
  title: string,
  fetchInspect: () => Promise<string>,
  renderSummary: (data: unknown) => string
): void {
  const bodyHtml = `
    <div id="inspect-summary">Loading&hellip;</div>
    <div class="logs-output" id="inspect-raw" style="display:none;"></div>
  `;
  const footerHtml = `
    <button class="btn" data-act="toggle-raw" type="button">Show Raw JSON</button>
    <button class="btn" data-act="refresh" type="button">Refresh</button>
  `;
  const { root } = openModal({ title, bodyHtml, footerHtml, wide: true, maximizable: true });

  const summaryEl = root.querySelector<HTMLElement>("#inspect-summary")!;
  const rawEl = root.querySelector<HTMLElement>("#inspect-raw")!;
  const toggleBtn = root.querySelector<HTMLButtonElement>('[data-act="toggle-raw"]')!;

  let rawVisible = false;

  const load = async () => {
    summaryEl.innerHTML = `<p>Loading&hellip;</p>`;
    rawEl.textContent = "";
    try {
      const rawText = await fetchInspect();
      rawEl.textContent = formatJson(rawText);

      let data: unknown = null;
      try {
        const parsed = JSON.parse(rawText);
        data = Array.isArray(parsed) ? parsed[0] : parsed;
      } catch {
        data = null;
      }

      summaryEl.innerHTML = data
        ? renderSummary(data)
        : `<p class="inspect-empty">Couldn't parse structured data — see raw JSON.</p>`;
    } catch (e) {
      summaryEl.innerHTML = `<p class="inspect-empty">Failed to load: ${escapeHtml(errMessage(e))}</p>`;
    }
  };

  toggleBtn.addEventListener("click", () => {
    rawVisible = !rawVisible;
    rawEl.style.display = rawVisible ? "block" : "none";
    toggleBtn.textContent = rawVisible ? "Hide Raw JSON" : "Show Raw JSON";
  });

  root.querySelector('[data-act="refresh"]')?.addEventListener("click", load);
  void load();
}

const STATS_POLL_MS = 2000;

function parsePercent(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const n = parseFloat(raw.replace("%", ""));
  return Number.isFinite(n) ? n : null;
}

function severityFromPercent(pct: number | null): "green" | "amber" | "red" {
  if (pct === null) return "green";
  if (pct >= 90) return "red";
  if (pct >= 70) return "amber";
  return "green";
}

/**
 * Live CPU/memory usage for one container. Polls `podman stats --no-stream`
 * on an interval rather than a streaming subprocess, so there's no long-lived
 * child process to track and kill when the modal closes — just clear the timer.
 */
export function openStatsModal(title: string, fetchStats: () => Promise<string>): void {
  const bodyHtml = `
    <div class="stats-tiles">
      <div class="stat-tile">
        <div class="stat-tile-label"><span class="severity-dot" id="stats-cpu-dot"></span>CPU</div>
        <div class="stat-tile-value" id="stats-cpu-value">&mdash;</div>
      </div>
      <div class="stat-tile">
        <div class="stat-tile-label"><span class="severity-dot" id="stats-mem-dot"></span>Memory</div>
        <div class="stat-tile-value" id="stats-mem-value">&mdash;</div>
        <div class="stat-tile-sub" id="stats-mem-sub"></div>
        <div class="meter-track"><div class="meter-fill" id="stats-mem-fill" style="width: 0%"></div></div>
      </div>
    </div>
    <dl class="inspect-grid stats-extra" id="stats-extra"></dl>
  `;

  let timer: number | undefined;
  const { root } = openModal({
    title,
    bodyHtml,
    onClose: () => {
      if (timer !== undefined) window.clearInterval(timer);
    },
  });

  const cpuDot = root.querySelector<HTMLElement>("#stats-cpu-dot")!;
  const cpuValue = root.querySelector<HTMLElement>("#stats-cpu-value")!;
  const memDot = root.querySelector<HTMLElement>("#stats-mem-dot")!;
  const memValue = root.querySelector<HTMLElement>("#stats-mem-value")!;
  const memSub = root.querySelector<HTMLElement>("#stats-mem-sub")!;
  const memFill = root.querySelector<HTMLElement>("#stats-mem-fill")!;
  const extra = root.querySelector<HTMLElement>("#stats-extra")!;

  const load = async () => {
    try {
      const raw = await fetchStats();
      const parsed = JSON.parse(raw);
      const data = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!data) {
        cpuValue.textContent = "—";
        memValue.textContent = "No data";
        return;
      }

      const cpuPct = parsePercent(data.cpu_percent);
      const memPct = parsePercent(data.mem_percent);
      const cpuSeverity = severityFromPercent(cpuPct);
      const memSeverity = severityFromPercent(memPct);

      cpuValue.textContent = cpuPct !== null ? `${cpuPct.toFixed(1)}%` : String(data.cpu_percent ?? "—");
      cpuDot.className = `severity-dot ${cpuSeverity}`;

      const memParts = typeof data.mem_usage === "string" ? data.mem_usage.split(" / ") : [];
      memValue.textContent = memParts[0] ?? String(data.mem_usage ?? "—");
      memSub.textContent = memParts[1] ? `of ${memParts[1]} limit` : "";
      memDot.className = `severity-dot ${memSeverity}`;
      memFill.style.width = `${Math.min(memPct ?? 0, 100)}%`;
      memFill.className = `meter-fill${memSeverity === "green" ? "" : " " + memSeverity}`;

      extra.innerHTML = `
        <dt>Net I/O</dt><dd>${escapeHtml(String(data.net_io ?? "—"))}</dd>
        <dt>Block I/O</dt><dd>${escapeHtml(String(data.block_io ?? "—"))}</dd>
        <dt>PIDs</dt><dd>${escapeHtml(String(data.pids ?? "—"))}</dd>
      `;
    } catch (e) {
      cpuValue.textContent = "—";
      memValue.textContent = `Failed to load: ${errMessage(e)}`;
    }
  };

  void load();
  timer = window.setInterval(() => void load(), STATS_POLL_MS);
}
