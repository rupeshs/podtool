import { mountIcons, icon } from "./icons";
import {
  api,
  CleanupOptions,
  CleanupResult,
  ContainerAction,
  ContainerSummary,
  ImageSummary,
  NetworkSummary,
  StatusInfo,
  VolumeSummary,
  errMessage,
} from "./api";
import { toast } from "./toast";
import { openModal, confirmDialog, openLogsModal, openInspectModal, openStatsModal } from "./modal";
import { escapeHtml, formatBytes, formatRelativeTime } from "./format";
import { ThemePref, cycleTheme, getThemePref, initTheme } from "./theme";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";

initTheme();

type View = "containers" | "images" | "volumes" | "networks";

const LOG_TAIL_LINES = 300;
const STATUS_POLL_MS = 6000;
const VIEW_TITLES: Record<View, string> = {
  containers: "Containers",
  images: "Images",
  volumes: "Volumes",
  networks: "Networks",
};
const PROTECTED_NETWORKS = new Set(["podman", "host", "none"]);

let currentView: View = "containers";
let containers: ContainerSummary[] = [];
let images: ImageSummary[] = [];
let volumes: VolumeSummary[] = [];
let networks: NetworkSummary[] = [];
let searchQuery = "";
let statusInfo: StatusInfo | null = null;
let loadingContent = true;
let busyIds = new Set<string>();

const contentEl = () => document.getElementById("content")!;
const viewTitleEl = () => document.getElementById("view-title")!;

function main(): void {
  mountIcons();
  wireNav();
  wireTopbar();
  wireStatusPill();
  wireThemeToggle();
  wireAbout();

  void refreshStatus();
  void loadCurrentView();

  window.setInterval(() => void refreshStatus(), STATUS_POLL_MS);
}

document.addEventListener("DOMContentLoaded", main);

// ---------------------------------------------------------------------------
// Navigation & topbar
// ---------------------------------------------------------------------------

function wireNav(): void {
  document.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view as View;
      if (view === currentView) return;
      currentView = view;
      searchQuery = "";
      (document.getElementById("search-input") as HTMLInputElement).value = "";

      document
        .querySelectorAll(".nav-item")
        .forEach((el) => el.classList.toggle("is-active", el === btn));
      viewTitleEl().textContent = VIEW_TITLES[view];

      void loadCurrentView();
    });
  });
}

function wireTopbar(): void {
  const search = document.getElementById("search-input") as HTMLInputElement;
  search.addEventListener("input", () => {
    searchQuery = search.value.trim().toLowerCase();
    renderContent();
  });

  const refreshBtn = document.getElementById("refresh-btn") as HTMLButtonElement;
  refreshBtn.addEventListener("click", () => {
    void refreshStatus();
    void loadCurrentView();
  });

  const cleanupBtn = document.getElementById("cleanup-btn") as HTMLButtonElement;
  cleanupBtn.addEventListener("click", () => void openCleanupModal());
}

function wireStatusPill(): void {
  const pill = document.getElementById("status-pill")!;
  pill.addEventListener("click", () => void openConnectionModal());
}

const THEME_ICONS: Record<ThemePref, string> = { system: "monitor", light: "sun", dark: "moon" };
const THEME_LABELS: Record<ThemePref, string> = { system: "System", light: "Light", dark: "Dark" };

function wireThemeToggle(): void {
  const btn = document.getElementById("theme-toggle") as HTMLButtonElement;
  renderThemeToggle(btn, getThemePref());
  btn.addEventListener("click", () => renderThemeToggle(btn, cycleTheme()));
}

function renderThemeToggle(btn: HTMLButtonElement, pref: ThemePref): void {
  btn.title = `Theme: ${THEME_LABELS[pref]}`;
  btn.innerHTML = `<span data-icon="${THEME_ICONS[pref]}"></span>`;
  mountIcons(btn);
}

function wireAbout(): void {
  document.getElementById("brand-btn")?.addEventListener("click", () => void openAboutModal());
  void listen("show-about", () => void openAboutModal());
}

async function openAboutModal(): Promise<void> {
  let version = "";
  try {
    version = await getVersion();
  } catch {
    version = "";
  }

  const bodyHtml = `
    <div class="about-header">
      <span class="brand-mark" aria-hidden="true">${icon("box")}</span>
      <div>
        <div class="about-title">PodTool</div>
        <div class="about-version">${version ? `Version ${escapeHtml(version)}` : ""}</div>
      </div>
    </div>
    <p>A lightweight desktop UI for managing Podman containers, images, volumes, and networks.</p>
    <p>Licensed under the MIT License.</p>
  `;
  openModal({ title: "About", bodyHtml });
}

// ---------------------------------------------------------------------------
// Status polling
// ---------------------------------------------------------------------------

async function refreshStatus(): Promise<void> {
  const wasConnected = statusInfo?.connected ?? null;
  try {
    statusInfo = await api.status();
  } catch (e) {
    statusInfo = { connected: false, version: null, message: errMessage(e), kind: "generic" };
  }
  renderStatusPill();

  if (statusInfo.connected && wasConnected === false) {
    void loadCurrentView();
  } else if (!statusInfo.connected) {
    // Always re-render (not just on the connected->disconnected edge) so the
    // content pane can never drift out of sync with the status pill above.
    renderContent();
  }
}

function renderStatusPill(): void {
  const dot = document.getElementById("status-dot")!;
  const text = document.getElementById("status-text")!;
  const pill = document.getElementById("status-pill")!;

  dot.classList.remove("connected", "disconnected");
  if (!statusInfo) {
    text.textContent = "Checking…";
    pill.classList.remove("is-clickable");
    return;
  }

  if (statusInfo.connected) {
    dot.classList.add("connected");
    text.textContent = statusInfo.version ? `Podman ${statusInfo.version}` : "Connected";
  } else {
    dot.classList.add("disconnected");
    text.textContent = disconnectedLabel(statusInfo);
  }
  pill.classList.add("is-clickable");
}

function disconnectedLabel(info: StatusInfo): string {
  switch (info.kind) {
    case "not_installed":
      return "Podman not installed";
    case "not_connected":
      return "Machine not running";
    default:
      return "Connection error";
  }
}

async function openConnectionModal(): Promise<void> {
  if (statusInfo?.connected) {
    openModal({
      title: "Podman connected",
      bodyHtml: `<p>Client version <strong>${escapeHtml(statusInfo.version ?? "unknown")}</strong>.</p>`,
    });
    return;
  }

  const notInstalled = statusInfo?.kind === "not_installed";
  const versionLine = statusInfo?.version
    ? `<p>Client version <strong>${escapeHtml(statusInfo.version)}</strong> is installed.</p>`
    : "";
  const bodyHtml = notInstalled
    ? `<p>${escapeHtml(statusInfo?.message ?? "Podman isn't installed.")}</p>
       <p>Install Podman and reopen PodTool. See <strong>podman.io</strong> for setup instructions.</p>`
    : `${versionLine}
       <p>${escapeHtml(statusInfo?.message ?? "Can't reach Podman.")}</p>
       <p>If you're on Windows or macOS, PodTool can try starting the Podman machine for you.</p>`;

  const footerHtml = notInstalled
    ? ""
    : `<button class="btn primary" data-act="start-machine" type="button">
         <span data-icon="plug"></span> Start Podman Machine
       </button>`;

  const title = notInstalled ? "Podman not installed" : "Podman machine not running";
  const { root, close } = openModal({ title, bodyHtml, footerHtml });
  mountIcons(root);

  root.querySelector('[data-act="start-machine"]')?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Starting…`;
    try {
      await api.startMachine();
      toast("Podman machine started");
      close();
      await refreshStatus();
      void loadCurrentView();
    } catch (err) {
      toast(`Couldn't start Podman machine: ${errMessage(err)}`, "error");
      btn.disabled = false;
      btn.innerHTML = `<span data-icon="plug"></span> Start Podman Machine`;
      mountIcons(root);
    }
  });
}

// ---------------------------------------------------------------------------
// Clean up
// ---------------------------------------------------------------------------

async function openCleanupModal(): Promise<void> {
  const bodyHtml = `
    <p>Remove everything not currently in use:</p>
    <label class="checkbox-row">
      <input type="checkbox" id="cleanup-opt-containers" checked />
      <span>Stopped containers</span>
    </label>
    <label class="checkbox-row">
      <input type="checkbox" id="cleanup-opt-images" checked />
      <span>Unused images<span class="hint">Any image not used by a container, tagged or not</span></span>
    </label>
    <label class="checkbox-row">
      <input type="checkbox" id="cleanup-opt-volumes" checked />
      <span>Unused volumes<span class="hint">Not attached to any container &mdash; this deletes their data</span></span>
    </label>
    <label class="checkbox-row">
      <input type="checkbox" id="cleanup-opt-networks" checked />
      <span>Unused networks<span class="hint">Not attached to any container</span></span>
    </label>
    <p class="hint">This can't be undone.</p>
  `;
  const footerHtml = `
    <button class="btn" data-act="cancel" type="button">Cancel</button>
    <button class="btn danger" data-act="run" type="button">Clean Up</button>
  `;

  const { root, close } = openModal({ title: "Clean up", bodyHtml, footerHtml });

  root.querySelector('[data-act="cancel"]')?.addEventListener("click", close);
  root.querySelector('[data-act="run"]')?.addEventListener("click", async (e) => {
    const opts: CleanupOptions = {
      containers: (root.querySelector("#cleanup-opt-containers") as HTMLInputElement).checked,
      images: (root.querySelector("#cleanup-opt-images") as HTMLInputElement).checked,
      volumes: (root.querySelector("#cleanup-opt-volumes") as HTMLInputElement).checked,
      networks: (root.querySelector("#cleanup-opt-networks") as HTMLInputElement).checked,
    };
    if (!opts.containers && !opts.images && !opts.volumes && !opts.networks) {
      toast("Select at least one category to clean up", "error");
      return;
    }

    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Cleaning up…`;

    try {
      const results = await api.cleanup(opts);
      renderCleanupResults(root, results, close);
      toast("Clean up complete");
      void loadCurrentView();
    } catch (err) {
      toast(`Clean up failed: ${errMessage(err)}`, "error");
      close();
    }
  });
}

function renderCleanupResults(root: HTMLElement, results: CleanupResult[], close: () => void): void {
  const rows = results
    .map((r) => {
      const iconName = r.ok ? "check" : "alert";
      return `
        <div class="cleanup-result-row ${r.ok ? "ok" : "error"}">
          <span class="result-icon">${icon(iconName)}</span>
          <span class="result-category">${escapeHtml(r.category)}</span>
          <span class="result-message">${escapeHtml(r.message)}</span>
        </div>`;
    })
    .join("");

  const body = root.querySelector(".modal-body")!;
  body.innerHTML = `<div class="cleanup-results">${rows}</div>`;

  const footer = root.querySelector(".modal-footer")!;
  footer.innerHTML = `<button class="btn primary" data-act="done" type="button">Done</button>`;
  footer.querySelector('[data-act="done"]')?.addEventListener("click", close);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadCurrentView(): Promise<void> {
  loadingContent = true;
  renderContent();

  try {
    if (currentView === "containers") {
      containers = await api.listContainers();
    } else if (currentView === "images") {
      images = await api.listImages();
    } else if (currentView === "volumes") {
      volumes = await api.listVolumes();
    } else {
      networks = await api.listNetworks();
    }
    if (statusInfo && !statusInfo.connected) {
      statusInfo = { ...statusInfo, connected: true, message: null };
      renderStatusPill();
    }
  } catch (e) {
    if (isNotConnected(e)) {
      statusInfo = statusInfo
        ? { ...statusInfo, connected: false, message: errMessage(e), kind: "not_connected" }
        : { connected: false, version: null, message: errMessage(e), kind: "not_connected" };
      renderStatusPill();
    } else {
      toast(errMessage(e), "error");
    }
  } finally {
    loadingContent = false;
    renderContent();
  }
}

function isNotConnected(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { kind?: string }).kind === "not_connected";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderContent(): void {
  if (statusInfo && !statusInfo.connected) {
    renderDisconnected();
    return;
  }
  if (loadingContent) {
    contentEl().innerHTML = `<div class="loading-row"><span class="spinner dark"></span> Loading…</div>`;
    return;
  }
  if (currentView === "containers") {
    renderContainers();
  } else if (currentView === "images") {
    renderImages();
  } else if (currentView === "volumes") {
    renderVolumes();
  } else {
    renderNetworks();
  }
}

function renderDisconnected(): void {
  const notInstalled = statusInfo?.kind === "not_installed";
  const title =
    statusInfo?.kind === "not_installed"
      ? "Podman isn't installed"
      : statusInfo?.kind === "not_connected"
        ? "Podman machine isn't running"
        : "Can't reach Podman";
  const versionLine = statusInfo?.version
    ? `<p>Client version <strong>${escapeHtml(statusInfo.version)}</strong> is installed.</p>`
    : "";
  contentEl().innerHTML = `
    <div class="empty-state">
      <span class="empty-icon">${icon("plug")}</span>
      <h2>${escapeHtml(title)}</h2>
      ${versionLine}
      <p>${escapeHtml(statusInfo?.message ?? "PodTool can't reach Podman right now.")}</p>
      ${notInstalled
      ? `<p>Install it from <code>podman.io</code>, then use the refresh button above.</p>`
      : `<button class="btn primary" id="empty-start-machine" type="button">
               <span data-icon="plug"></span> Start Podman Machine
             </button>`
    }
    </div>
  `;
  mountIcons(contentEl());

  document.getElementById("empty-start-machine")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Starting…`;
    try {
      await api.startMachine();
      toast("Podman machine started");
      await refreshStatus();
      void loadCurrentView();
    } catch (err) {
      toast(`Couldn't start Podman machine: ${errMessage(err)}`, "error");
      btn.disabled = false;
      btn.innerHTML = `<span data-icon="plug"></span> Start Podman Machine`;
      mountIcons(contentEl());
    }
  });
}

function renderContainers(): void {
  const filtered = containers.filter((c) => {
    if (!searchQuery) return true;
    return (
      c.name.toLowerCase().includes(searchQuery) ||
      c.image.toLowerCase().includes(searchQuery) ||
      c.status.toLowerCase().includes(searchQuery)
    );
  });

  if (containers.length === 0) {
    contentEl().innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">${icon("box")}</span>
        <h2>No containers yet</h2>
        <p>Containers you create with <code>podman run</code> will show up here.</p>
      </div>`;
    return;
  }

  if (filtered.length === 0) {
    contentEl().innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">${icon("search")}</span>
        <h2>No matches</h2>
        <p>No containers match "${escapeHtml(searchQuery)}".</p>
      </div>`;
    return;
  }

  const rows = filtered
    .map((c) => {
      const isRunning = c.state === "running";
      const isBusy = busyIds.has(c.id);
      const created = formatRelativeTime(c.createdAt);

      const actions: string[] = [];
      if (!isRunning) {
        actions.push(actionBtn("start", "play", "Start", isBusy));
      } else {
        actions.push(actionBtn("stop", "stop", "Stop", isBusy));
        actions.push(actionBtn("restart", "rotate", "Restart", isBusy));
        actions.push(actionBtn("stats", "activity", "Stats", isBusy));
      }
      actions.push(actionBtn("inspect", "info", "Details", isBusy));
      actions.push(actionBtn("logs", "logs", "Logs", isBusy));
      actions.push(actionBtn("remove", "trash", "Remove", isBusy, true));

      return `
        <tr data-id="${escapeHtml(c.id)}">
          <td class="cell-primary">${escapeHtml(c.name)}</td>
          <td class="cell-dim">${escapeHtml(c.image)}</td>
          <td>${badge(c.state)}</td>
          <td class="cell-dim" title="${escapeHtml(created.title)}">${escapeHtml(created.text)}</td>
          <td class="cell-dim">${escapeHtml(c.ports || "—")}</td>
          <td><div class="row-actions">${actions.join("")}</div></td>
        </tr>`;
    })
    .join("");

  contentEl().innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Image</th>
          <th>State</th>
          <th>Created</th>
          <th>Ports</th>
          <th class="th-actions">Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  mountIcons(contentEl());
  wireContainerRows();
}

function renderImages(): void {
  const filtered = images.filter((i) => {
    if (!searchQuery) return true;
    return i.repoTags.toLowerCase().includes(searchQuery) || i.shortId.includes(searchQuery);
  });

  if (images.length === 0) {
    contentEl().innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">${icon("layers")}</span>
        <h2>No images yet</h2>
        <p>Images you pull or build with Podman will show up here.</p>
      </div>`;
    return;
  }

  if (filtered.length === 0) {
    contentEl().innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">${icon("search")}</span>
        <h2>No matches</h2>
        <p>No images match "${escapeHtml(searchQuery)}".</p>
      </div>`;
    return;
  }

  const rows = filtered
    .map((img) => {
      const isBusy = busyIds.has(img.id);
      const created = formatRelativeTime(img.createdAt);
      return `
        <tr data-id="${escapeHtml(img.id)}">
          <td class="cell-primary">${escapeHtml(img.repoTags)}</td>
          <td class="cell-mono">${escapeHtml(img.shortId)}</td>
          <td class="cell-dim">${formatBytes(img.sizeBytes)}</td>
          <td class="cell-dim" title="${escapeHtml(created.title)}">${escapeHtml(created.text)}</td>
          <td class="cell-dim">${img.containers >= 0 ? img.containers : "—"}</td>
          <td><div class="row-actions">${actionBtn("inspect", "info", "Details", isBusy)}${actionBtn("remove", "trash", "Remove", isBusy, true)}</div></td>
        </tr>`;
    })
    .join("");

  contentEl().innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Repository : Tag</th>
          <th>Image ID</th>
          <th>Size</th>
          <th>Created</th>
          <th>Containers</th>
          <th class="th-actions">Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  mountIcons(contentEl());
  wireImageRows();
}

function renderVolumes(): void {
  const filtered = volumes.filter((v) => {
    if (!searchQuery) return true;
    return v.name.toLowerCase().includes(searchQuery) || v.driver.toLowerCase().includes(searchQuery);
  });

  if (volumes.length === 0) {
    contentEl().innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">${icon("database")}</span>
        <h2>No volumes yet</h2>
        <p>Volumes created with <code>podman volume create</code> or by containers will show up here.</p>
      </div>`;
    return;
  }

  if (filtered.length === 0) {
    contentEl().innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">${icon("search")}</span>
        <h2>No matches</h2>
        <p>No volumes match "${escapeHtml(searchQuery)}".</p>
      </div>`;
    return;
  }

  const rows = filtered
    .map((v) => {
      const isBusy = busyIds.has(v.name);
      const created = formatRelativeTime(v.createdAt);
      return `
        <tr data-id="${escapeHtml(v.name)}">
          <td class="cell-primary">${escapeHtml(v.name)}</td>
          <td class="cell-dim">${escapeHtml(v.driver || "—")}</td>
          <td class="cell-dim" title="${escapeHtml(created.title)}">${escapeHtml(created.text)}</td>
          <td><div class="row-actions">${actionBtn("inspect", "info", "Details", isBusy)}${actionBtn("remove", "trash", "Remove", isBusy, true)}</div></td>
        </tr>`;
    })
    .join("");

  contentEl().innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Driver</th>
          <th>Created</th>
          <th class="th-actions">Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  mountIcons(contentEl());
  wireVolumeRows();
}

function renderNetworks(): void {
  const filtered = networks.filter((n) => {
    if (!searchQuery) return true;
    return n.name.toLowerCase().includes(searchQuery) || n.driver.toLowerCase().includes(searchQuery);
  });

  if (networks.length === 0) {
    contentEl().innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">${icon("network")}</span>
        <h2>No networks yet</h2>
        <p>Networks created with <code>podman network create</code> will show up here.</p>
      </div>`;
    return;
  }

  if (filtered.length === 0) {
    contentEl().innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">${icon("search")}</span>
        <h2>No matches</h2>
        <p>No networks match "${escapeHtml(searchQuery)}".</p>
      </div>`;
    return;
  }

  const rows = filtered
    .map((n) => {
      const isProtected = PROTECTED_NETWORKS.has(n.name);
      const isBusy = busyIds.has(n.id || n.name);
      const created = formatRelativeTime(n.createdAt);
      const removeBtn = actionBtn(
        "remove",
        "trash",
        isProtected ? "Built-in network" : "Remove",
        isBusy || isProtected,
        true
      );
      const inspectBtn = actionBtn("inspect", "info", "Details", isBusy);
      return `
        <tr data-id="${escapeHtml(n.id || n.name)}">
          <td class="cell-primary">${escapeHtml(n.name)}</td>
          <td class="cell-dim">${escapeHtml(n.driver || "—")}</td>
          <td class="cell-dim">${escapeHtml(n.subnets || "—")}</td>
          <td>${n.internal ? '<span class="badge state-exited"><span class="dot"></span>internal</span>' : '<span class="cell-dim">—</span>'}</td>
          <td class="cell-dim" title="${escapeHtml(created.title)}">${escapeHtml(created.text)}</td>
          <td><div class="row-actions">${inspectBtn}${removeBtn}</div></td>
        </tr>`;
    })
    .join("");

  contentEl().innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Driver</th>
          <th>Subnet</th>
          <th>Internal</th>
          <th>Created</th>
          <th class="th-actions">Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  mountIcons(contentEl());
  wireNetworkRows();
}

function actionBtn(action: string, iconName: string, label: string, busy: boolean, danger = false): string {
  return `
    <button class="action-btn ${danger ? "danger" : ""}" data-action="${action}" title="${label}" ${busy ? "disabled" : ""} type="button">
      <span data-icon="${iconName}"></span>
    </button>`;
}

function badge(state: string): string {
  const known = ["running", "exited", "paused", "created"];
  const cls = known.includes(state) ? state : "unknown";
  return `<span class="badge state-${cls}"><span class="dot"></span>${escapeHtml(state)}</span>`;
}

// ---------------------------------------------------------------------------
// Row wiring
// ---------------------------------------------------------------------------

function wireContainerRows(): void {
  contentEl()
    .querySelectorAll<HTMLTableRowElement>("tbody tr")
    .forEach((row) => {
      const id = row.dataset.id!;
      const c = containers.find((x) => x.id === id);
      if (!c) return;

      row.querySelectorAll<HTMLButtonElement>(".action-btn").forEach((btn) => {
        btn.addEventListener("click", () => void handleContainerAction(c, btn.dataset.action!));
      });
    });
}

async function handleContainerAction(c: ContainerSummary, action: string): Promise<void> {
  if (action === "logs") {
    openLogsModal(`Logs · ${c.name}`, () => api.containerLogs(c.id, LOG_TAIL_LINES));
    return;
  }

  if (action === "inspect") {
    openInspectModal(`Details · ${c.name}`, () => api.inspectContainer(c.id), renderContainerInspect);
    return;
  }

  if (action === "stats") {
    openStatsModal(`Stats · ${c.name}`, () => api.containerStats(c.id));
    return;
  }

  if (action === "remove") {
    const isRunning = c.state === "running";
    const ok = await confirmDialog({
      title: "Remove container",
      message: isRunning
        ? `<strong>${escapeHtml(c.name)}</strong> is running. It will be force-stopped and removed. Continue?`
        : `Remove <strong>${escapeHtml(c.name)}</strong>? This can't be undone.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;

    await runBusy(c.id, async () => {
      await api.removeContainer(c.id, isRunning);
      containers = containers.filter((x) => x.id !== c.id);
      toast(`Removed ${c.name}`);
      renderContent();
    });
    return;
  }

  const validActions: ContainerAction[] = ["start", "stop", "restart"];
  if (!validActions.includes(action as ContainerAction)) return;

  await runBusy(c.id, async () => {
    await api.containerAction(c.id, action as ContainerAction);
    toast(`${capitalize(action)}ed ${c.name}`);
    await loadCurrentView();
  });
}

function wireImageRows(): void {
  contentEl()
    .querySelectorAll<HTMLTableRowElement>("tbody tr")
    .forEach((row) => {
      const id = row.dataset.id!;
      const img = images.find((x) => x.id === id);
      if (!img) return;

      row.querySelectorAll<HTMLButtonElement>(".action-btn").forEach((btn) => {
        btn.addEventListener("click", () => void handleImageAction(img, btn.dataset.action!));
      });
    });
}

async function handleImageAction(img: ImageSummary, action: string): Promise<void> {
  if (action === "inspect") {
    openInspectModal(`Details · ${img.repoTags}`, () => api.inspectImage(img.id), renderImageInspect);
    return;
  }
  if (action !== "remove") return;

  const inUse = img.containers > 0;
  const ok = await confirmDialog({
    title: "Remove image",
    message: inUse
      ? `<strong>${escapeHtml(img.repoTags)}</strong> is used by ${img.containers} container(s). Removal will fail unless they're deleted first. Try anyway?`
      : `Remove <strong>${escapeHtml(img.repoTags)}</strong>? This can't be undone.`,
    confirmLabel: "Remove",
    danger: true,
  });
  if (!ok) return;

  await runBusy(img.id, async () => {
    try {
      await api.removeImage(img.id, false);
      images = images.filter((x) => x.id !== img.id);
      toast(`Removed ${img.repoTags}`);
      renderContent();
    } catch (e) {
      toast(errMessage(e), "error");
    }
  });
}

function wireVolumeRows(): void {
  contentEl()
    .querySelectorAll<HTMLTableRowElement>("tbody tr")
    .forEach((row) => {
      const name = row.dataset.id!;
      const v = volumes.find((x) => x.name === name);
      if (!v) return;

      row.querySelectorAll<HTMLButtonElement>(".action-btn").forEach((btn) => {
        btn.addEventListener("click", () => void handleVolumeAction(v, btn.dataset.action!));
      });
    });
}

async function handleVolumeAction(v: VolumeSummary, action: string): Promise<void> {
  if (action === "inspect") {
    openInspectModal(`Details · ${v.name}`, () => api.inspectVolume(v.name), renderVolumeInspect);
    return;
  }
  if (action !== "remove") return;

  const ok = await confirmDialog({
    title: "Remove volume",
    message: `Remove <strong>${escapeHtml(v.name)}</strong>? Any data it holds will be lost. This can't be undone.`,
    confirmLabel: "Remove",
    danger: true,
  });
  if (!ok) return;

  await runBusy(v.name, async () => {
    try {
      await api.removeVolume(v.name, false);
      volumes = volumes.filter((x) => x.name !== v.name);
      toast(`Removed ${v.name}`);
      renderContent();
    } catch (e) {
      toast(errMessage(e), "error");
    }
  });
}

function wireNetworkRows(): void {
  contentEl()
    .querySelectorAll<HTMLTableRowElement>("tbody tr")
    .forEach((row) => {
      const id = row.dataset.id!;
      const n = networks.find((x) => (x.id || x.name) === id);
      if (!n) return;

      row.querySelectorAll<HTMLButtonElement>(".action-btn").forEach((btn) => {
        btn.addEventListener("click", () => void handleNetworkAction(n, btn.dataset.action!));
      });
    });
}

async function handleNetworkAction(n: NetworkSummary, action: string): Promise<void> {
  if (action === "inspect") {
    openInspectModal(`Details · ${n.name}`, () => api.inspectNetwork(n.name), renderNetworkInspect);
    return;
  }
  if (action !== "remove") return;
  if (PROTECTED_NETWORKS.has(n.name)) return;

  const ok = await confirmDialog({
    title: "Remove network",
    message: `Remove <strong>${escapeHtml(n.name)}</strong>? Containers attached to it may lose connectivity. This can't be undone.`,
    confirmLabel: "Remove",
    danger: true,
  });
  if (!ok) return;

  const key = n.id || n.name;
  await runBusy(key, async () => {
    try {
      await api.removeNetwork(n.name, false);
      networks = networks.filter((x) => (x.id || x.name) !== key);
      toast(`Removed ${n.name}`);
      renderContent();
    } catch (e) {
      toast(errMessage(e), "error");
    }
  });
}

async function runBusy(id: string, fn: () => Promise<void>): Promise<void> {
  busyIds.add(id);
  renderContent();
  try {
    await fn();
  } catch (e) {
    toast(errMessage(e), "error");
  } finally {
    busyIds.delete(id);
    renderContent();
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Inspect summaries
//
// `podman ... inspect` schemas are large and vary by podman version, so these
// pull out the fields people actually look for and leave everything else to
// the raw-JSON fallback in the inspect modal, rather than modeling the full
// schema.
// ---------------------------------------------------------------------------

function inspectSection(title: string): string {
  return `<div class="inspect-section-title">${escapeHtml(title)}</div>`;
}

function inspectKv(pairs: Array<[string, unknown]>): string {
  const rows = pairs.filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (rows.length === 0) return `<p class="inspect-empty">None</p>`;
  return `<dl class="inspect-grid">${rows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`)
    .join("")}</dl>`;
}

function inspectPre(lines: string[]): string {
  if (lines.length === 0) return `<p class="inspect-empty">None</p>`;
  return `<pre class="inspect-pre">${escapeHtml(lines.join("\n"))}</pre>`;
}

function formatPortBindings(ports: unknown): string | undefined {
  if (!ports || typeof ports !== "object") return undefined;
  const rows = Object.entries(ports as Record<string, unknown>)
    .filter(([, bindings]) => Array.isArray(bindings) && bindings.length > 0)
    .map(([containerPort, bindings]) => {
      const hostSide = (bindings as Array<{ HostIp?: string; HostPort?: string }>)
        .map((b) => `${b.HostIp || "0.0.0.0"}:${b.HostPort}`)
        .join(", ");
      return `${hostSide} → ${containerPort}`;
    });
  return rows.length ? rows.join(", ") : undefined;
}

function renderContainerInspect(data: any): string {
  const state = data?.State ?? {};
  const config = data?.Config ?? {};
  const name = String(data?.Name ?? "").replace(/^\//, "");
  const cmd = Array.isArray(config?.Cmd) ? config.Cmd.join(" ") : config?.Cmd;
  const ports = formatPortBindings(data?.NetworkSettings?.Ports);
  const mounts = (data?.Mounts ?? []).map(
    (m: any) => `${m.Source ?? m.Name ?? "?"} → ${m.Destination}${m.RW === false ? " (ro)" : ""}`
  );
  const env: string[] = config?.Env ?? [];
  const labels: Record<string, string> = config?.Labels ?? {};

  return [
    inspectSection("Overview"),
    inspectKv([
      ["Name", name],
      ["Image", data?.ImageName ?? data?.Image],
      ["Status", state?.Status],
      ["Created", data?.Created],
      ["Started", state?.StartedAt],
      ["Exit code", state?.ExitCode],
      ["Command", cmd],
      ["Working dir", config?.WorkingDir],
      ["Ports", ports],
    ]),
    inspectSection("Mounts"),
    inspectPre(mounts),
    inspectSection("Environment"),
    inspectPre(env),
    inspectSection("Labels"),
    inspectKv(Object.entries(labels)),
  ].join("");
}

function renderImageInspect(data: any): string {
  const config = data?.Config ?? {};
  const labels: Record<string, string> = config?.Labels ?? {};
  const entrypoint = Array.isArray(config?.Entrypoint) ? config.Entrypoint.join(" ") : config?.Entrypoint;
  const cmd = Array.isArray(config?.Cmd) ? config.Cmd.join(" ") : config?.Cmd;
  const layers = Array.isArray(data?.RootFS?.Layers) ? data.RootFS.Layers.length : undefined;

  return [
    inspectSection("Overview"),
    inspectKv([
      ["Repo tags", (data?.RepoTags ?? []).join(", ") || "<none>"],
      ["Id", data?.Id],
      ["Created", data?.Created],
      ["Size", data?.Size != null ? formatBytes(data.Size) : undefined],
      ["Platform", [data?.Architecture, data?.Os].filter(Boolean).join(" / ")],
      ["Entrypoint", entrypoint],
      ["Command", cmd],
      ["Working dir", config?.WorkingDir],
      ["Layers", layers],
    ]),
    inspectSection("Labels"),
    inspectKv(Object.entries(labels)),
  ].join("");
}

function renderVolumeInspect(data: any): string {
  const labels: Record<string, string> = data?.Labels ?? {};
  const options: Record<string, string> = data?.Options ?? {};

  return [
    inspectSection("Overview"),
    inspectKv([
      ["Name", data?.Name],
      ["Driver", data?.Driver],
      ["Mountpoint", data?.Mountpoint],
      ["Scope", data?.Scope],
      ["Created", data?.CreatedAt],
    ]),
    inspectSection("Options"),
    inspectKv(Object.entries(options)),
    inspectSection("Labels"),
    inspectKv(Object.entries(labels)),
  ].join("");
}

function renderNetworkInspect(data: any): string {
  const subnets: Array<{ subnet?: string; gateway?: string }> = data?.subnets ?? [];
  const labels: Record<string, string> = data?.labels ?? {};

  return [
    inspectSection("Overview"),
    inspectKv([
      ["Name", data?.name],
      ["Id", data?.id],
      ["Driver", data?.driver],
      ["Interface", data?.network_interface],
      ["Internal", data?.internal ? "Yes" : "No"],
      ["DNS enabled", data?.dns_enabled ? "Yes" : "No"],
      ["Created", data?.created],
    ]),
    inspectSection("Subnets"),
    inspectKv(subnets.map((s) => [s.subnet ?? "?", s.gateway])),
    inspectSection("Labels"),
    inspectKv(Object.entries(labels)),
  ].join("");
}
