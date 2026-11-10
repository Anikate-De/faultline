export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

export function formatMetric(
  value: number,
  unit: string,
  format?: "number" | "percent" | "ms" | "rps" | "bytes" | "count",
): string {
  if (!Number.isFinite(value)) return `0${unit}`;
  if (format === "rps") {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M${unit}`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k${unit}`;
    return `${Math.round(value)}${unit}`;
  }
  if (format === "bytes") {
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
    return `${Math.round(value)} B`;
  }
  if (format === "percent" || unit === "%") return `${value.toFixed(value < 10 ? 1 : 0)}%`;
  if (format === "ms") return `${value.toFixed(value < 10 ? 1 : 0)}ms`;
  if (format === "count") {
    if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M${unit}`;
    return `${Math.round(value).toLocaleString("en-US")}${unit}`;
  }
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded}${unit}`;
}

export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatDate(iso: string | Date): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function daysFromNow(days: number, now = new Date()): string {
  const next = new Date(now);
  next.setDate(next.getDate() + days);
  return next.toISOString();
}

export function readingTime(minutes: number): string {
  return `${minutes} min`;
}

export function difficultyLabel(d: number): string {
  return d === 1 ? "Intro" : d === 2 ? "Core" : d === 3 ? "Advanced" : "Expert";
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function percent(value: number): string {
  return `${Math.round(value)}%`;
}
