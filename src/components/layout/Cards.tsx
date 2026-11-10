import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Clock3, FileWarning, Lock } from "lucide-react";
import type { ManifestModule } from "@/content/manifest";
import type { TrackId } from "@/content/types";
import { TRACK_BY_ID } from "@/content/tracks";
import { hasAuthoredCase } from "@/case-files/registry";
import { useAppStore } from "@/lib/store";
import { difficultyLabel, pluralize } from "@/lib/format";
import { Badge, DifficultyBadge } from "@/components/ui/Badge";
import { ProgressRing } from "@/components/ui/Progress";
import { CheckCircle2 } from "lucide-react";

export function ModuleCard({
  module,
  authored,
  showDelta = true,
}: {
  module: ManifestModule;
  authored: boolean;
  showDelta?: boolean;
}) {
  const complete = useAppStore((s) => Boolean(s.completed[module.id]));
  const track = TRACK_BY_ID.get(module.track);
  const inner = (
    <>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-raised font-mono text-xs text-faint">
          {String(module.order).padStart(2, "0")}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-sm font-semibold text-text">{module.title}</h3>
            {complete ? <CheckCircle2 aria-label="Completed" className="size-4 text-success" /> : null}
            {!authored ? <Badge tone="warn">In authoring</Badge> : null}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">{module.productionQuestion}</p>
          {showDelta ? (
            <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-faint">{module.learningDelta}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <DifficultyBadge value={module.difficulty} />
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-faint">
              <Clock3 aria-hidden="true" className="size-3" />
              {module.minutes}m
            </span>
            {track ? <span className="font-mono text-[10px] text-faint">{track.short}</span> : null}
          </div>
        </div>
        {authored ? <ArrowRight aria-hidden="true" className="mt-1 size-4 shrink-0 text-faint" /> : <Lock aria-hidden="true" className="mt-1 size-4 shrink-0 text-faint" />}
      </div>
    </>
  );
  if (!authored) {
    return <div className="rounded-[12px] border border-border bg-surface p-3">{inner}</div>;
  }
  return (
    <Link to={`/modules/${module.slug}`} className="block rounded-[12px] border border-border bg-surface p-3 transition-colors hover:border-faint">
      {inner}
    </Link>
  );
}

export function TrackCard({ trackId }: { trackId: TrackId }) {
  const track = TRACK_BY_ID.get(trackId);
  const completed = useAppStore((s) => s.completed);
  if (!track) return null;
  const done = completed ? Object.keys(completed).filter((id) => id.startsWith(`${track.id}-`)).length : 0;
  const percent = track.planned ? Math.round((done / track.planned) * 100) : 0;
  if (track.reserved) {
    return (
      <div className="rounded-[16px] border border-dashed border-border bg-surface p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-text">{track.title}</h3>
          <Badge tone="interview">Later</Badge>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted">{track.description}</p>
      </div>
    );
  }
  return (
    <Link to={`/tracks/${track.id}`} className="group rounded-[16px] border border-border bg-surface p-4 transition-colors hover:border-faint">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text">{track.title}</h3>
          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-faint">{pluralize(track.planned, "module")}</p>
        </div>
        <ProgressRing value={percent} size={44} label={`${track.title}: ${percent} percent complete`} />
      </div>
      <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted">{track.purpose}</p>
      <p className="mt-2 font-mono text-[10px] text-faint">{done} completed</p>
    </Link>
  );
}

export function CaseFileCard({ module }: { module: ManifestModule }) {
  const kind = module.caseFile?.startsWith("Composite") ? "composite" : "real";
  const authored = hasAuthoredCase(module.slug);
  return (
    <Link to={`/case-files/${module.slug}`} className="block rounded-[16px] border border-border bg-surface p-4 transition-colors hover:border-faint">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={kind === "real" ? "info" : "interview"}>{kind === "real" ? "Public incident" : "Composite"}</Badge>
        <Badge>{module.caseFile}</Badge>
        {authored ? <Badge tone="success">Authored</Badge> : null}
      </div>
      <h3 className="mt-2 text-sm font-semibold text-text">{module.title}</h3>
      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">{module.purpose}</p>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-faint">{module.minutes}m · Case file</span>
        <span className="inline-flex items-center gap-1 text-[10px] text-faint">
          <FileWarning aria-hidden="true" className="size-3" />
          {authored ? "Authored case file" : "In authoring"}
        </span>
      </div>
    </Link>
  );
}

export function CaseFileRow({ limit = 3 }: { limit?: number }) {
  const [modules, setModules] = useState<ManifestModule[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      import("@/content/manifest")
        .then(({ CASE_FILES }) => {
          if (alive) setModules(CASE_FILES.slice(0, limit));
        })
        .catch(() => undefined);
    };
    const timer = window.setTimeout(load, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [limit]);
  if (modules.length === 0) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
        {Array.from({ length: limit }).map((_, index) => (
          <div key={index} className="h-32 animate-pulse rounded-[16px] border border-border bg-surface" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {modules.map((module) => (
        <CaseFileCard key={module.id} module={module} />
      ))}
    </div>
  );
}

export function DifficultyLabel({ value }: { value: number }) {
  return <span className="font-mono text-[10px] text-faint">{difficultyLabel(value)}</span>;
}
