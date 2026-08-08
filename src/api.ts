import { invoke } from "@tauri-apps/api/core";

export type ErrorKind = "not_installed" | "not_connected" | "generic";

export interface PodmanError {
  kind: ErrorKind;
  message: string;
}

export function isPodmanError(e: unknown): e is PodmanError {
  return (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    "message" in e
  );
}

export function errMessage(e: unknown): string {
  if (isPodmanError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export interface ContainerSummary {
  id: string;
  shortId: string;
  name: string;
  image: string;
  status: string;
  state: string;
  createdAt: string;
  ports: string;
}

export interface ImageSummary {
  id: string;
  shortId: string;
  repoTags: string;
  sizeBytes: number;
  createdAt: string;
  containers: number;
}

export interface StatusInfo {
  connected: boolean;
  version: string | null;
  message: string | null;
  kind: ErrorKind | null;
}

export interface VolumeSummary {
  name: string;
  driver: string;
  scope: string;
  createdAt: string;
}

export interface NetworkSummary {
  id: string;
  shortId: string;
  name: string;
  driver: string;
  createdAt: string;
  internal: boolean;
  subnets: string;
}

export interface MachineInfo {
  name: string;
  running: boolean;
  default: boolean;
}

export interface CleanupOptions {
  containers: boolean;
  images: boolean;
  volumes: boolean;
  networks: boolean;
}

export interface CleanupResult {
  category: string;
  ok: boolean;
  message: string;
}

export type ContainerAction =
  | "start"
  | "stop"
  | "restart"
  | "pause"
  | "unpause"
  | "kill";

export const api = {
  status: () => invoke<StatusInfo>("podman_status"),
  listContainers: () => invoke<ContainerSummary[]>("list_containers"),
  listImages: () => invoke<ImageSummary[]>("list_images"),
  containerAction: (id: string, action: ContainerAction) =>
    invoke<void>("container_action", { id, action }),
  removeContainer: (id: string, force: boolean) =>
    invoke<void>("remove_container", { id, force }),
  removeImage: (id: string, force: boolean) =>
    invoke<void>("remove_image", { id, force }),
  containerLogs: (id: string, tail: number) =>
    invoke<string>("container_logs", { id, tail }),
  containerStats: (id: string) => invoke<string>("container_stats", { id }),
  listVolumes: () => invoke<VolumeSummary[]>("list_volumes"),
  removeVolume: (name: string, force: boolean) =>
    invoke<void>("remove_volume", { name, force }),
  listNetworks: () => invoke<NetworkSummary[]>("list_networks"),
  removeNetwork: (name: string, force: boolean) =>
    invoke<void>("remove_network", { name, force }),
  cleanup: (opts: CleanupOptions) => invoke<CleanupResult[]>("cleanup_all", { ...opts }),
  inspectContainer: (id: string) => invoke<string>("inspect_container", { id }),
  inspectImage: (id: string) => invoke<string>("inspect_image", { id }),
  inspectVolume: (name: string) => invoke<string>("inspect_volume", { name }),
  inspectNetwork: (name: string) => invoke<string>("inspect_network", { name }),
  listMachines: () => invoke<MachineInfo[]>("list_machines"),
  startMachine: (name?: string) =>
    invoke<void>("start_machine", { name: name ?? null }),
};
