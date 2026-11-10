import { useEffect, useState } from "react";
import { Bookmark, Check, CheckCircle2, Circle } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { Badge } from "./Badge";
import { cn } from "@/lib/format";
import { Button } from "./Button";

export function BookmarkButton({ moduleId, compact = false }: { moduleId: string; compact?: boolean }) {
  const bookmarked = useAppStore((s) => s.bookmarks.includes(moduleId));
  const toggle = useAppStore((s) => s.toggleBookmark);
  return (
    <Button
      size="sm"
      variant={bookmarked ? "secondary" : "ghost"}
      aria-pressed={bookmarked}
      onClick={() => toggle(moduleId)}
      className={cn(bookmarked && "text-accent")}
    >
      <Bookmark aria-hidden="true" className={cn("size-4", bookmarked && "fill-current")} />
      {compact ? <span className="sr-only">{bookmarked ? "Remove bookmark" : "Bookmark module"}</span> : bookmarked ? "Bookmarked" : "Bookmark"}
    </Button>
  );
}

export function CompletionButton({ moduleId }: { moduleId: string }) {
  const completedAt = useAppStore((s) => s.completed[moduleId]);
  const markComplete = useAppStore((s) => s.markComplete);
  const unmarkComplete = useAppStore((s) => s.unmarkComplete);
  if (completedAt) {
    return (
      <div className="flex items-center gap-1">
        <Badge tone="success" dot>
          Completed
        </Badge>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Undo mark complete"
          onClick={() => unmarkComplete(moduleId)}
        >
          Undo
        </Button>
      </div>
    );
  }
  return (
    <Button size="sm" variant="primary" onClick={() => markComplete(moduleId)}>
      <Check aria-hidden="true" className="size-4" />
      Mark complete
    </Button>
  );
}

export function ProgressRing({
  value,
  size = 56,
  label,
}: {
  value: number;
  size?: number;
  label?: string;
}) {
  const radius = (size - 6) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      className="relative inline-flex shrink-0 items-center justify-center"
      role="img"
      aria-label={label ?? `${Math.round(clamped)} percent complete`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--border)" strokeWidth="4" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped / 100)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="absolute font-mono text-[11px] tabular-nums text-text">{Math.round(clamped)}%</span>
    </div>
  );
}

export function ReadingProgress() {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const update = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(max > 0 ? Math.min(100, (window.scrollY / max) * 100) : 0);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return (
    <div
      className="fixed inset-x-0 top-0 z-40 h-0.5 bg-transparent"
      role="progressbar"
      aria-label="Reading progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress)}
    >
      <div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${progress}%` }} />
    </div>
  );
}

export function CompletionDot({ complete }: { complete: boolean }) {
  return complete ? (
    <CheckCircle2 aria-label="Completed" className="size-4 text-success" />
  ) : (
    <Circle aria-label="Not completed" className="size-4 text-faint" />
  );
}
