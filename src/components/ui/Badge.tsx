import type { ReactNode } from "react";
import { cn } from "@/lib/format";
import type { Tone } from "@/content/types";

const toneClasses: Record<Tone, string> = {
  info: "bg-[var(--tone-info-bg)] border-[var(--tone-info-border)] text-info",
  warn: "bg-[var(--tone-warn-bg)] border-[var(--tone-warn-border)] text-warn",
  danger: "bg-[var(--tone-danger-bg)] border-[var(--tone-danger-border)] text-danger",
  success: "bg-[var(--tone-success-bg)] border-[var(--tone-success-border)] text-success",
  interview: "bg-[var(--tone-interview-bg)] border-[var(--tone-interview-border)] text-[var(--interview)]",
};

interface BadgeProps {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
}

export function Badge({ tone = "info", children, className, dot = false }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.08em]",
        toneClasses[tone],
        className,
      )}
    >
      {dot ? <span aria-hidden="true" className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export function DifficultyBadge({ value }: { value: number }) {
  const label = value === 1 ? "Intro" : value === 2 ? "Core" : value === 3 ? "Advanced" : "Expert";
  const tone: Tone = value === 1 ? "success" : value === 2 ? "info" : value === 3 ? "warn" : "danger";
  return <Badge tone={tone}>{label}</Badge>;
}

export function StatusBadge({ state }: { state: "ok" | "warn" | "crit" | "down" }) {
  const map = {
    ok: { tone: "success" as Tone, label: "Healthy" },
    warn: { tone: "warn" as Tone, label: "Saturated" },
    crit: { tone: "danger" as Tone, label: "Failing" },
    down: { tone: "danger" as Tone, label: "Unavailable" },
  };
  const item = map[state];
  return (
    <Badge tone={item.tone} dot>
      {item.label}
    </Badge>
  );
}
