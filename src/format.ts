export function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

export function formatRelativeTime(raw: string): { text: string; title: string } {
  if (!raw) return { text: "—", title: "" };
  const date = parseLoose(raw);
  if (!date) return { text: raw, title: raw };

  const title = date.toLocaleString();
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);

  if (diffSec < 5) return { text: "just now", title };
  if (diffSec < 60) return { text: `${diffSec}s ago`, title };
  const min = Math.floor(diffSec / 60);
  if (min < 60) return { text: `${min}m ago`, title };
  const hr = Math.floor(min / 60);
  if (hr < 24) return { text: `${hr}h ago`, title };
  const day = Math.floor(hr / 24);
  if (day < 30) return { text: `${day}d ago`, title };
  return { text: date.toLocaleDateString(), title };
}

function parseLoose(raw: string): Date | null {
  const s = raw.trim();

  const direct = new Date(s);
  if (!isNaN(direct.getTime())) return direct;

  // Go's `time.Time.String()` form: "2024-05-01 12:00:00.123456 +0000 UTC"
  const goLike = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (goLike) {
    const normalized = new Date(`${goLike[1]}T${goLike[2]}Z`);
    if (!isNaN(normalized.getTime())) return normalized;
  }

  if (/^\d+$/.test(s)) {
    const n = Number(s);
    const ms = n > 2_000_000_0000 ? n : n * 1000;
    const fromEpoch = new Date(ms);
    if (!isNaN(fromEpoch.getTime())) return fromEpoch;
  }

  return null;
}
