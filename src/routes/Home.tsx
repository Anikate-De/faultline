import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Beaker, BookOpen, Gauge, Radio, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import { AUTHORED_METAS } from "@/modules/registry";
import { TRACKS, PATHWAY } from "@/content/tracks";
import { DRILLS } from "@/content/drills";
import { useAppStore } from "@/lib/store";
import { pluralize } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { RevealPanel } from "@/components/ui/Reveal";
import { CaseFileRow, TrackCard } from "@/components/layout/Cards";
import { ProgressRing } from "@/components/ui/Progress";

function ContinueCard() {
  const lastModule = useAppStore((s) => s.lastModule);
  const completed = useAppStore((s) => s.completed);
  const candidate =
    (lastModule ? AUTHORED_METAS.find((m) => m.id === lastModule) : undefined) ?? AUTHORED_METAS[0];
  if (!candidate) {
    return (
      <div className="rounded-[16px] border border-dashed border-border bg-surface p-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint">Continue</p>
        <p className="mt-1 text-sm text-muted">The first authored module is in review. The 456-module manifest is frozen.</p>
      </div>
    );
  }
  const complete = Boolean(completed[candidate.id]);
  return (
    <Link
      to={`/modules/${candidate.slug}`}
      className="group flex items-center gap-4 rounded-[16px] border border-border bg-surface p-5 transition-colors hover:border-faint"
    >
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint">{complete ? "Revisit" : "Continue"}</p>
        <h2 className="mt-1 truncate text-lg font-semibold text-text">{candidate.title}</h2>
        <p className="mt-1 line-clamp-2 text-sm text-muted">{candidate.productionQuestion}</p>
        <p className="mt-2 font-mono text-[10px] text-faint">
          {candidate.track} · {candidate.minutes} min
        </p>
      </div>
      <ProgressRing value={complete ? 100 : 0} size={56} label={complete ? "Completed" : "Not started"} />
      <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

function DailyDrill() {
  const [day] = useState(() => Math.floor(Date.now() / 86_400_000));
  const available = DRILLS.filter((item) => AUTHORED_METAS.some((module) => module.id === item.moduleId));
  const drill = available[day % Math.max(1, available.length)] ?? DRILLS[0];
  const module = AUTHORED_METAS.find((item) => item.id === drill.moduleId);
  return (
    <div className="rounded-[16px] border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="interview">
          <Sparkles aria-hidden="true" className="size-3" />
          Today&apos;s drill
        </Badge>
        <span className="font-mono text-[10px] text-faint">Hidden answer</span>
      </div>
      <p className="mt-2 text-sm font-medium leading-relaxed text-text">{drill.question}</p>
      <div className="mt-3">
        <RevealPanel label="Model answer" tone="interview" hint="Say it out loud first.">
          <p>{drill.answer}</p>
        </RevealPanel>
      </div>
      {module ? (
        <Link to={`/modules/${module.slug}#interview`} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
          Open the interview drill <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      ) : null}
    </div>
  );
}

export default function Home() {
  const completed = useAppStore((s) => s.completed);
  const completedCount = Object.keys(completed).length;
  return (
    <div className="space-y-10">
      <section className="max-w-3xl">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-accent">An interactive SRE field lab</p>
        <h1 className="mt-2">Break the system. Read the signal. Learn the fix.</h1>
        <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted">
          Faultline is a working lab for production failure: realistic systems, real signals, and the tradeoff
          behind every fix. No dashboards to admire. One question per module, answered by breaking something.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-faint">
          <span className="font-mono">{pluralize(TRACKS.reduce((sum, track) => sum + track.planned, 0), "module")} in the frozen manifest</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono">{AUTHORED_METAS.length} authored</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono">{pluralize(TRACKS.find((track) => track.id === "case-files")?.planned ?? 0, "case file")}</span>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <ContinueCard />
        <DailyDrill />
      </section>

      <section>
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h2>Tracks</h2>
            <p className="text-sm text-muted">A field lab, ordered from mental models to production incidents.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link to="/curriculum" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
              All modules <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
            <Link to="/tracks" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
              All tracks <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {TRACKS.filter((track) => track.id !== "case-files" && track.id !== "kubernetes")
            .slice(0, 8)
            .map((track) => (
              <TrackCard key={track.id} trackId={track.id} />
            ))}
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h2>Case files</h2>
            <p className="text-sm text-muted">Public incidents and clearly labeled composites.</p>
          </div>
          <Link to="/case-files" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
            All 60 <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        </div>
        <CaseFileRow />
      </section>

      <section className="rounded-[16px] border border-border bg-surface p-5">
        <h2>How a module works</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {[
            { icon: BookOpen, title: "Explain", body: "What it is, where it sits, and what normal looks like before any slider." },
            { icon: Beaker, title: "Break", body: "Predict, set the controls, run the model, and watch the incident become unmistakable." },
            { icon: Wrench, title: "Fix", body: "Find the first check, apply the fix, and state the tradeoff it introduces." },
          ].map((item) => (
            <div key={item.title} className="flex gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-raised text-accent">
                <item.icon aria-hidden="true" className="size-4" />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-text">{item.title}</h3>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">{item.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>Start here</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          {PATHWAY.map((path) => (
            <Link
              key={path.id}
              to={`/tracks/${path.tracks[0]}`}
              className="rounded-[16px] border border-border bg-surface p-4 transition-colors hover:border-faint"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-text">{path.title}</h3>
                <Radio aria-hidden="true" className="size-4 text-accent" />
              </div>
              <p className="mt-1 text-xs text-muted">{path.note}</p>
              <p className="mt-2 font-mono text-[10px] text-faint">{path.tracks.slice(0, 3).join(" → ")}</p>
            </Link>
          ))}
        </div>
      </section>

      {completedCount > 0 ? (
        <section className="rounded-[16px] border border-border bg-surface p-5">
          <div className="flex flex-wrap items-center gap-3">
            <Gauge aria-hidden="true" className="size-5 text-accent" />
            <p className="text-sm text-text">
              {pluralize(completedCount, "module")} completed. The review queue schedules confidence ratings at 1, 3, 7, and 21 days.
            </p>
            <Link to="/review" className="ml-auto text-sm text-accent hover:underline">
              Review now
            </Link>
          </div>
        </section>
      ) : (
        <section className="flex flex-wrap items-center gap-3 rounded-[16px] border border-border bg-surface p-5">
          <ShieldCheck aria-hidden="true" className="size-5 text-accent" />
          <p className="text-sm text-muted">
            Answers stay hidden by default. Interview mode hides every quiz key, experiment explanation, and model answer until you reveal it.
          </p>
        </section>
      )}
    </div>
  );
}
