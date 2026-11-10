import { useState, type ReactNode } from "react";
import { AlertTriangle, CalendarClock, FileWarning, GitBranch, Landmark, ListChecks, ShieldCheck } from "lucide-react";
import type { CaseStudy, ModuleMeta, Tone } from "@/content/types";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { RevealPanel } from "@/components/ui/Reveal";
import { BlockRenderer, ReferenceList } from "@/components/content/Blocks";
import { DiagramFrame } from "@/components/content/DiagramFrame";
import { cn } from "@/lib/format";

const qualityTone: Record<"good" | "mixed" | "poor", Tone> = {
  good: "success",
  mixed: "warn",
  poor: "danger",
};

const eventDot: Record<Tone, string> = {
  info: "bg-info",
  warn: "bg-warn",
  danger: "bg-danger",
  success: "bg-success",
  interview: "bg-[var(--interview)]",
};

function SectionHeading({
  id,
  icon,
  title,
  note,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  note?: string;
}) {
  return (
    <div id={id} className="flex scroll-mt-24 items-center gap-2 border-b border-border pb-2">
      <span className="text-accent">{icon}</span>
      <h2 className="text-sm font-semibold text-text">{title}</h2>
      {note ? <span className="ml-auto font-mono text-[10px] text-faint">{note}</span> : null}
    </div>
  );
}

function DecisionCard({ decision, index }: { decision: CaseStudy["decisions"][number]; index: number }) {
  const [selected, setSelected] = useState<string | null>(null);
  const choice = decision.options.find((option) => option.id === selected);
  function select(id: string) {
    setSelected(id);
  }
  return (
    <div className="rounded-[16px] border border-border bg-surface p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
        Decision {String(index + 1).padStart(2, "0")}
      </p>
      <h3 className="mt-1 text-base font-semibold text-text">{decision.prompt}</h3>
      <div role="radiogroup" aria-label={decision.prompt} className="mt-3 grid gap-2">
        {decision.options.map((option, optionIndex) => {
          const active = option.id === selected;
          return (
            <button
              key={option.id}
              id={`decision-${decision.id}-${option.id}`}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active || (!selected && optionIndex === 0) ? 0 : -1}
              onClick={() => select(option.id)}
              onKeyDown={(event) => {
                const current = decision.options.findIndex((item) => item.id === selected);
                const start = current === -1 ? 0 : current;
                let next: number;
                if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (start + 1) % decision.options.length;
                else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (start - 1 + decision.options.length) % decision.options.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = decision.options.length - 1;
                else return;
                event.preventDefault();
                const target = decision.options[next];
                select(target.id);
                document.getElementById(`decision-${decision.id}-${target.id}`)?.focus();
              }}
              className={cn(
                "flex min-h-11 items-center justify-between gap-3 rounded-[10px] border px-3 py-2 text-left text-sm transition-colors",
                active
                  ? "border-accent bg-[var(--tone-info-bg)] text-text"
                  : "border-border bg-raised/40 text-muted hover:border-faint hover:text-text",
              )}
            >
              <span>{option.label}</span>
              {active ? <Badge tone={qualityTone[option.quality]}>{option.quality}</Badge> : null}
            </button>
          );
        })}
      </div>
      {choice ? (
        <div role="status" className="mt-3 rounded-[10px] border border-border bg-raised p-3 text-sm leading-relaxed text-muted">
          <span className="font-medium text-text">Consequence. </span>
          {choice.consequence}
        </div>
      ) : (
        <p className="mt-3 text-xs text-faint">Commit to an option before reading its consequence.</p>
      )}
      <div className="mt-3">
        <RevealPanel label="Reveal decision debrief" hint="Read after you have committed to an option.">
          <p>{decision.debrief}</p>
        </RevealPanel>
      </div>
    </div>
  );
}

export function CaseFileView({ meta, study }: { meta: ModuleMeta; study: CaseStudy }) {
  const composite = study.kind === "composite";
  return (
    <div className="mx-auto max-w-4xl space-y-8 py-2" data-case-file-ready="true">
      <header className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={composite ? "interview" : "info"}>
            {composite ? "Composite scenario" : "Public incident"}
          </Badge>
          <Badge>Case file</Badge>
          <Badge tone="success">Authored</Badge>
        </div>
        <div>
          <h1 className="text-2xl font-semibold sm:text-3xl">{meta.title}</h1>
          <p className="mt-2 text-base leading-relaxed text-muted">{meta.productionQuestion}</p>
        </div>

        <dl className="grid gap-2 rounded-[16px] border border-border bg-surface p-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-faint">
              <Landmark aria-hidden="true" className="size-3" /> Company
            </dt>
            <dd className="mt-1 text-muted">{study.company}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-faint">
              <CalendarClock aria-hidden="true" className="size-3" /> Date
            </dt>
            <dd className="mt-1 text-muted">{study.date}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-faint">
              <AlertTriangle aria-hidden="true" className="size-3" /> Incident class
            </dt>
            <dd className="mt-1 text-muted">{study.incidentClass}</dd>
          </div>
        </dl>

        {composite ? (
          <Callout tone="interview" title="Composite scenario — not a real incident.">
            {study.accuracyNote}
          </Callout>
        ) : (
          <Callout tone="warn" title="Accuracy note">
            {study.accuracyNote}
          </Callout>
        )}
      </header>

      {study.architecture ? (
        <section className="space-y-3">
          <DiagramFrame
            id={study.architecture.id}
            title="Architecture"
            caption={
              composite
                ? "Illustrative path for this scenario. It shows dependency shape, not any real organization's network."
                : "Architecture as described in the public sources. Verify the path against the cited postmortem."
            }
          />
        </section>
      ) : null}

      <section className="space-y-3">
        <SectionHeading
          id="timeline"
          icon={<GitBranch aria-hidden="true" className="size-4" />}
          title="Timeline"
          note="Relative times · illustrative sequence"
        />
        <ol className="space-y-4 border-l border-border pl-4">
          {study.timeline.map((event, index) => (
            <li key={`${event.at}-${index}`} className="relative">
              <span
                aria-hidden="true"
                className={cn("absolute -left-[21px] top-1.5 size-2 rounded-full", eventDot[event.tone ?? "info"])}
              />
              <p className="font-mono text-[10px] text-faint">{event.at}</p>
              <p className="text-sm font-medium text-text">{event.title}</p>
              <p className="text-sm leading-relaxed text-muted">{event.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-3">
        <SectionHeading
          id="decisions"
          icon={<ListChecks aria-hidden="true" className="size-4" />}
          title="Decision points"
          note="Consequences after choice · debriefs hidden"
        />
        <div className="space-y-3">
          {study.decisions.map((decision, index) => (
            <DecisionCard key={decision.id} decision={decision} index={index} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeading
          id="postmortem"
          icon={<ShieldCheck aria-hidden="true" className="size-4" />}
          title="Postmortem"
          note="What changed and what generalizes"
        />
        <BlockRenderer blocks={study.postmortem} />
      </section>

      <section className="space-y-3">
        <SectionHeading
          id="sources"
          icon={<FileWarning aria-hidden="true" className="size-4" />}
          title="Sources"
          note={`${study.sources.length} reference${study.sources.length === 1 ? "" : "s"}`}
        />
        <ReferenceList references={study.sources} />
      </section>
    </div>
  );
}
