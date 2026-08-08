# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PodTool is a cross-platform desktop app (Tauri v2 + Rust backend, vanilla TypeScript frontend, no frontend framework) for listing and managing Podman containers, images, volumes, and networks. All Podman interaction happens by shelling out to the `podman` CLI (`std::process::Command`) — there is no REST API/socket client. This keeps it working regardless of how the user's Podman is configured (WSL machine, native Linux, etc.), since the CLI already knows how to connect.

## Commands

```bash
npm install                        # install JS deps
npm run tauri dev                  # dev mode: Vite dev server + Rust app with hot reload
npm run tauri build -- --no-bundle # release build, exe only: src-tauri/target/release/podtool.exe
npm run tauri build                # release build + OS installer (see gotcha below)

cd src-tauri && cargo check        # fast Rust typecheck (no codegen)
npx tsc --noEmit                   # frontend typecheck
```

There is no automated test suite (no test runner is configured). Verification is `cargo check` + `tsc --noEmit` plus manually running the built app against a real Podman install.

### Gotcha: full `tauri build` can fail with `timeout: global`

The first time you run `npm run tauri build` (without `--no-bundle`), Tauri needs to download the WiX Toolset (for the `.msi`) and NSIS (for the `.exe` installer) from GitHub. The bundler's HTTP client has a short timeout that can fail even when a plain `curl` to the same URL succeeds fine. If you just need a working binary (not an installer), use `npm run tauri build -- --no-bundle`.

## Architecture

### Backend (`src-tauri/src/`)

- `podman.rs` — all Podman logic. Two helpers, `run()` and `run_combined()`, wrap `Command::new("podman")`, hide the console window on Windows (`CREATE_NO_WINDOW`), and classify failures into `PodmanError { kind, message }` where `kind` is `NotInstalled` / `NotConnected` / `Generic`. `NotInstalled` is only reported for a genuine `io::ErrorKind::NotFound` spawn failure — other spawn errors (e.g. transient sharing violations from several `podman.exe` launches racing at startup) fall back to `Generic` rather than the misleading "not installed".
  - `podman --format json` output is parsed into `serde_json::Value` and read with case-tolerant helpers (`get_str`, `get_num`, `get_str_array_joined`, `parse_json_array`) instead of `#[derive(Deserialize)]` structs, because field casing is inconsistent across resource types: containers/images/volumes use PascalCase (`Name`, `CreatedAt`), networks use snake_case (`name`, `created`).
  - `status()` runs `podman version` (works even with no daemon connection) followed by `podman ps` to determine `connected` + `version` + `kind` together — the client version and the connectivity error are meant to be reported at the same time so the UI isn't stuck deciding between them.
  - `cleanup()` runs `container/image/volume/network prune` for whichever categories are requested. Image *and volume* prune are always called with `-a` — by default `volume prune`/`image prune` only remove anonymous/dangling resources, silently skipping named volumes and tagged images, which is not what "clean up unused X" implies to a user.
- `lib.rs` — registers every `#[tauri::command]` (thin wrappers around `podman.rs`) in `invoke_handler!`, and sets up the tray icon + close-to-tray behavior in `.setup()`:
  - The `TrayIcon` returned by `TrayIconBuilder::build()` is stored via `app.manage(tray)`. If it isn't kept somewhere, the icon is removed from the OS tray the instant the temporary is dropped (looks like the tray icon "didn't register" even though it briefly did).
  - `WindowEvent::CloseRequested` calls `window.hide()` + `api.prevent_close()` instead of letting the app quit — closing the window minimizes to tray, and the tray menu's "Quit" is the only way to actually exit.

### Frontend (`src/`, plain TS + one `styles.css`, no build-time framework)

- `main.ts` is the single orchestrator: all app state lives in module-level `let` variables (current view, cached container/image/volume/network arrays, search query, connection status, in-flight/"busy" ids). There's no component framework or virtual DOM — each view render sets `innerHTML` on `#content` and re-attaches row event listeners after every render. Four views (containers/images/volumes/networks) share one topbar (search filter, Clean up, Refresh) and one sidebar nav.
- `api.ts` — one typed wrapper function per Tauri command. Rust command structs use `#[serde(rename_all = "camelCase")]`, so the TS interfaces here mirror the Rust field names directly with no extra mapping layer.
- `modal.ts` — a small generic modal system (`openModal`, `confirmDialog`, `openLogsModal`). `openModal` supports an optional maximize toggle (`.is-maximized` class swap). The logs modal adds its own in-content search/highlight (regex match wrapped in `<mark>`, current-match navigation) on top of the generic modal.
- `icons.ts` — hand-written inline SVG icons (feather-style outlines) keyed by name. `mountIcons(root)` walks `[data-icon]` elements under `root` and injects the matching SVG string; it must be re-called after any `innerHTML` write that introduces new `[data-icon]` elements, since those start out empty.
- Connection status (`refreshStatus()`, polled on an interval and after actions) drives both the sidebar status pill and the main content empty-state from the same `StatusInfo` object. Keep these two renders in sync when touching this path — they previously could disagree if only one of them re-rendered on a given poll tick.
- `styles.css` — CSS custom properties for theming, dark by default with a `@media (prefers-color-scheme: light)` override block (no `[data-theme]` toggle, purely OS-driven).

## Podman semantics worth knowing before changing prune/remove logic

- `podman volume prune` / `podman image prune` default to anonymous/dangling-only; this codebase always passes `-a`.
- `podman network prune` and `podman container prune` don't have that anonymous/all distinction.
- Removing a running container requires `-f` (force); the UI passes `force: true` only when the container is currently running, otherwise a plain `rm`.
- The `podman`/`host`/`none` networks are treated as protected in the UI (delete action disabled) — see `PROTECTED_NETWORKS` in `main.ts`.
