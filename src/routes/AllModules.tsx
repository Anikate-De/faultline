import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, FileWarning, Lock, Milestone } from "lucide-react";
import { MANIFEST } from "@/content/manifest";
import type { ManifestModule } from "@/content/manifest";
import { buildLearningPath, levelLabel, type LearningPathItem } from "@/content/learningPath";
import { TRACK_BY_ID } from "@/content/tracks";
import { AUTHORED_BY_SLUG } from "@/modules/registry";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/format";

const LEVELS = [1, 2, 3, 4] as const;

function CoreRow({ item }: { item: LearningPathItem }) {
  const module = item.module;
  const track = TRACK_BY_ID.get(module.track);
  const authored = AUTHORED_BY_SLUG.has(module.slug);
  const body = (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-raised font-mono text-[10px] text-faint">
        L{item.level}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <h3 className="text-sm font-medium text-text">{module.title}</h3>
          {authored ? <Badge tone="success">Authored</Badge> : <Badge tone="warn">In authoring</Badge>}
        </div>
        <p className="mt-0.5 line-clamp-1 text-xs text-muted">{module.productionQuestion}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] text-faint">
          <span>{track?.short ?? module.track}</span>
          <span aria-hidden="true">·</span>
          <span>{levelLabel(item.level)}</span>
          <span aria-hidden="true">·</span>
          <span>{module.minutes}m</span>
        </div>
      </div>
      {authored ? (
        <ArrowRight aria-hidden="true" className="mt-1 size-4 shrink-0 text-faint" />
      ) : (
        <Lock aria-hidden="true" className="mt-1 size-4 shrink-0 text-faint" />
      )}
    </div>
  );
  return authored ? (
    <Link to={`/modules/${module.slug}`} className="block rounded-[12px] border border-border bg-surface p-3 transition-colors hover:border-faint">
      {body}
    </Link>
  ) : (
    <div className="rounded-[12px] border border-border bg-surface p-3">{body}</div>
  );
}

function MilestoneRow({ module, level }: { module: ManifestModule; level: number }) {
  const track = TRACK_BY_ID.get(module.track);
  return (
    <Link
      to={`/case-files/${module.slug}`}
      className="group block rounded-[14px] border border-[var(--milestone-border)] bg-[var(--milestone-bg)] p-3 transition-colors hover:border-[var(--milestone-text)]"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md border border-[var(--milestone-border)] bg-[var(--milestone-bg)] text-[var(--milestone-text)]">
          <FileWarning aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="interview">Case file</Badge>
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--milestone-text)]">
              Milestone · Level {level}
            </span>
          </div>
          <h3 className="mt-1 text-sm font-semibold text-text">{module.title}</h3>
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">{module.purpose}</p>
          <p className="mt-1 font-mono text-[10px] text-[var(--milestone-text)]">
            {module.caseFile} · {track?.short}
          </p>
        </div>
        <ArrowRight aria-hidden="true" className="mt-1 size-4 shrink-0 text-[var(--milestone-text)]" />
      </div>
    </Link>
  );
}

export default function AllModules() {
  const path = useMemo(() => buildLearningPath(MANIFEST), []);
  const stepNumber = useMemo(() => new Map(path.map((item, index) => [item.module.id, index + 1])), [path]);
  const [activeLevel, setActiveLevel] = useState<number | null>(null);
  const levels = LEVELS.map((level) => ({
    level,
    items: path.filter((item) => item.level === level),
  })).filter((group) => group.items.length > 0);
  const shown = levels.filter((group) => activeLevel === null || group.level === activeLevel);

  return (
    <div className="space-y-6">
      <header className="max-w-3xl">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info">Curriculum path</Badge>
          <Badge tone="interview">
            <Milestone aria-hidden="true" className="size-3" />
            Purple = case-file milestone
          </Badge>
        </div>
        <h1 className="mt-2">All modules</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          One flat path through all {MANIFEST.length} modules. The level increases as you go, prerequisites come
          first, and case files sit at purple milestones after the knowledge they depend on. Categories rotate
          within a level so you are not stuck in one track.
        </p>
        <p className="mt-2 text-xs text-faint">
          Only authored modules open a lesson. Planned rows are honest about their state; case-file milestones show
          their planned header and sources plan.
        </p>
      </header>

      <div className="sticky top-14 z-10 -mx-1 overflow-x-auto border-y border-border bg-bg/95 px-1 py-2 backdrop-blur lg:top-16">
        <div className="flex min-w-max items-center gap-1.5">
          <span className="px-2 font-mono text-[10px] uppercase tracking-[0.08em] text-faint">Jump</span>
          <button
            type="button"
            aria-pressed={activeLevel === null}
            onClick={() => setActiveLevel(null)}
            className={cn(
              "min-h-10 rounded-md border px-3 text-xs",
              activeLevel === null ? "border-accent bg-accent/10 text-accent" : "border-border text-muted hover:text-text",
            )}
          >
            All levels
          </button>
          {levels.map((group) => (
            <button
              key={group.level}
              type="button"
              aria-pressed={activeLevel === group.level}
              onClick={() => setActiveLevel(group.level)}
              className={cn(
                "min-h-10 rounded-md border px-3 text-xs",
                activeLevel === group.level ? "border-accent bg-accent/10 text-accent" : "border-border text-muted hover:text-text",
              )}
            >
              Level {group.level} · {levelLabel(group.level)} <span className="font-mono text-[10px] text-faint">{group.items.length}</span>
            </button>
          ))}
        </div>
      </div>

      {shown.map((group) => (
        <section key={group.level} id={`level-${group.level}`} aria-labelledby={`level-${group.level}-title`} className="scroll-mt-32">
          <div className="mb-2 flex flex-wrap items-end gap-2">
            <h2 id={`level-${group.level}-title`} className="text-lg font-semibold">
              Level {group.level} · {levelLabel(group.level)}
            </h2>
            <span className="font-mono text-[10px] text-faint">{group.items.length} steps</span>
            <span className="ml-auto text-xs text-muted">
              {group.items.filter((item) => item.milestone).length} milestones
            </span>
          </div>
          <ol className="space-y-2">
            {group.items.map((item, index) => (
              <li key={item.module.id}>
                <div className="mb-1 flex items-center gap-2 px-1 font-mono text-[10px] text-faint">
                  <span>{String(stepNumber.get(item.module.id) ?? 0).padStart(3, "0")}</span>
                  {item.milestone ? <span className="text-[var(--milestone-text)]">Milestone</span> : null}
                </div>
                {item.milestone ? <MilestoneRow module={item.module} level={item.level} /> : <CoreRow item={item} />}
                {index === group.items.length - 1 ? null : <span className="sr-only">Next step</span>}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
