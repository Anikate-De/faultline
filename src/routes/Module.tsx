import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, BookOpen, CheckCircle2, Circle, Clock3, FileText, Lock, Target } from "lucide-react";
import type { Module as ModuleType } from "@/content/types";
import type { SimulationController } from "@/simulation/engine/useSimulation";
import { AUTHORED_BY_SLUG, loadModule } from "@/modules/registry";
import type { ManifestModule } from "@/content/manifest";
import { TRACK_BY_ID } from "@/content/tracks";
import { useAppStore } from "@/lib/store";
import { formatDate } from "@/lib/format";
import { Badge, DifficultyBadge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { ErrorBoundary, RouteFallback } from "@/components/ui/Feedback";
import { RevealPanel } from "@/components/ui/Reveal";
import { BookmarkButton, CompletionButton, ReadingProgress } from "@/components/ui/Progress";
import { ConfidencePicker } from "@/components/interview/InterviewQuestion";
import { BlockRenderer, ReferenceList } from "@/components/content/Blocks";
import { ExperimentCard } from "@/components/content/ExperimentCard";
import { InterviewQuestion } from "@/components/interview/InterviewQuestion";
import { SimShell } from "@/simulation/kit/SimShell";
import NotFound from "./NotFound";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; module: ModuleType }
  | { status: "error" };

export default function Module() {
  const { slug } = useParams();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [allModules, setAllModules] = useState<ManifestModule[]>([]);
  const controllerRef = useRef<SimulationController | null>(null);
  const markVisited = useAppStore((s) => s.markVisited);
  const completed = useAppStore((s) => s.completed);
  const authored = slug ? AUTHORED_BY_SLUG.has(slug) : false;

  useEffect(() => {
    if (!slug || !AUTHORED_BY_SLUG.has(slug)) return;
    let cancelled = false;
    loadModule(slug)
      .then((module) => {
        if (!cancelled) {
          setState({ status: "ready", module });
          markVisited(module.meta.id);
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [slug, markVisited]);

  useEffect(() => {
    let alive = true;
    import("@/content/manifest")
      .then(({ MANIFEST }) => {
        if (alive) setAllModules(MANIFEST);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (state.status === "ready") document.title = `${state.module.meta.title} — Faultline`;
    return () => {
      document.title = "Faultline — An interactive SRE and DevOps field lab";
    };
  }, [state]);

  if (!slug || !authored) return <NotFound />;
  if (state.status === "loading") return <RouteFallback />;
  if (state.status === "error") return <NotFound />;
  if (state.module.meta.slug !== slug) return <RouteFallback />;

  const module = state.module;
  const meta = module.meta;
  const track = TRACK_BY_ID.get(meta.track);
  const sim = Object.values(module.sims)[0];
  const trackModules = allModules.filter((item) => item.track === meta.track).sort((a, b) => a.order - b.order);
  const index = trackModules.findIndex((item) => item.id === meta.id);
  const prev = index > 0 ? trackModules[index - 1] : undefined;
  const next = index >= 0 && index < trackModules.length - 1 ? trackModules[index + 1] : undefined;
  const complete = Boolean(completed[meta.id]);
  const after = module.related
    .map((id) => allModules.find((item) => item.id === id))
    .filter((item): item is ManifestModule => Boolean(item))
    .slice(0, 3);

  return (
    <article data-module-ready="true" className="space-y-8">
      <ReadingProgress />
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-xs text-muted">
        <Link to="/tracks" className="hover:text-text">Tracks</Link>
        <span aria-hidden="true">/</span>
        <Link to={`/tracks/${meta.track}`} className="hover:text-text">{track?.title ?? meta.track}</Link>
        <span aria-hidden="true">/</span>
        <span className="text-faint">{meta.title}</span>
      </nav>

      <header className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <DifficultyBadge value={meta.difficulty} />
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-faint">
            <Clock3 aria-hidden="true" className="size-3" />
            {meta.minutes}m
          </span>
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-faint">
            <Target aria-hidden="true" className="size-3" />
            {module.interview.length} interview questions
          </span>
          {complete ? <Badge tone="success">Completed</Badge> : null}
        </div>
        <div className="max-w-4xl">
          <h1>{meta.title}</h1>
          <p className="mt-2 text-base leading-relaxed text-muted sm:text-lg">{meta.productionQuestion}</p>
        </div>
        <Callout tone="success" title="The one thing to remember">
          {meta.learningDelta}
        </Callout>
        <div className="flex flex-wrap items-center gap-2">
          <BookmarkButton moduleId={meta.id} />
          <CompletionButton moduleId={meta.id} />
          <span className="hidden h-6 w-px bg-border sm:block" />
          <ConfidencePicker moduleId={meta.id} compact />
        </div>
        {meta.objectives.length ? (
          <div>
            <h2 className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint">By the end</h2>
            <ul className="mt-1 grid gap-1 text-sm text-muted sm:grid-cols-2">
              {meta.objectives.map((objective) => (
                <li key={objective} className="flex gap-2">
                  <Circle aria-hidden="true" className="mt-1.5 size-2 shrink-0 fill-accent text-accent" />
                  {objective}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </header>

      <div className="grid gap-6 xl:grid-cols-12 xl:items-start">
        <div className="min-w-0 space-y-5 xl:col-span-7">
          <div className="flex items-center gap-2 border-b border-border pb-2">
            <BookOpen aria-hidden="true" className="size-4 text-accent" />
            <h2 className="text-sm font-semibold text-text">Primer</h2>
            <span className="ml-auto font-mono text-[10px] text-faint">Understand before you break it</span>
          </div>
          <BlockRenderer blocks={module.primer} />
          <div className="flex items-center gap-2 text-xs text-muted">
            <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
            Primer complete? The simulator is on the right on desktop, below on mobile.
          </div>
        </div>
        {sim ? (
          <aside className="min-w-0 xl:col-span-5 xl:sticky xl:top-20 xl:max-h-[calc(100dvh-6rem)] xl:overflow-y-auto">
            <ErrorBoundary>
              <SimShell key={meta.id} spec={sim} title={meta.title} controllerRef={controllerRef} />
            </ErrorBoundary>
          </aside>
        ) : null}
      </div>

      {module.experiments.length ? (
        <section id="experiments" className="scroll-mt-24 space-y-3">
          <div className="flex items-center gap-2 border-b border-border pb-2">
            <Target aria-hidden="true" className="size-4 text-accent" />
            <h2 className="text-sm font-semibold text-text">Guided experiments</h2>
            <span className="ml-auto font-mono text-[10px] text-faint">Predict, run, explain, fix</span>
          </div>
          <div className="grid gap-4 xl:max-w-4xl">
            {module.experiments.map((experiment) => (
              <ExperimentCard key={experiment.id} experiment={experiment} controllerRef={controllerRef} />
            ))}
          </div>
        </section>
      ) : null}

      <div className="max-w-4xl space-y-8">
        <section id="debrief" className="scroll-mt-24 space-y-4">
          <div className="flex items-center gap-2 border-b border-border pb-2">
            <FileText aria-hidden="true" className="size-4 text-accent" />
            <h2 className="text-sm font-semibold text-text">Debrief</h2>
          </div>
          <RevealPanel label="Reveal debrief" hint="Reveal after you have run the experiment and committed to an explanation.">
            <BlockRenderer blocks={module.debrief} />
          </RevealPanel>
        </section>

        <section id="interview" className="scroll-mt-24 space-y-3">
          <div className="flex items-center gap-2 border-b border-border pb-2">
            <Target aria-hidden="true" className="size-4 text-accent" />
            <h2 className="text-sm font-semibold text-text">Interview drill</h2>
            <span className="ml-auto font-mono text-[10px] text-faint">Answers hidden</span>
          </div>
          <div className="space-y-3">
            {module.interview.map((question, questionIndex) => (
              <InterviewQuestion key={question.id} question={question} index={questionIndex} />
            ))}
          </div>
        </section>

        <section id="checklist" className="scroll-mt-24 space-y-3">
          <div className="flex items-center gap-2 border-b border-border pb-2">
            <CheckCircle2 aria-hidden="true" className="size-4 text-accent" />
            <h2 className="text-sm font-semibold text-text">Production checklist</h2>
          </div>
          <div className="space-y-3">
            {module.checklist.map((group) => (
              <div key={group.title} className="rounded-[12px] border border-border bg-surface p-4">
                <h3 className="text-sm font-semibold text-text">{group.title}</h3>
                <ul className="mt-2 space-y-2">
                  {group.items.map((item) => (
                    <li key={item} className="flex gap-2 text-sm text-muted">
                      <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <section id="references" className="scroll-mt-24 space-y-3">
          <div className="flex items-center gap-2 border-b border-border pb-2">
            <BookOpen aria-hidden="true" className="size-4 text-accent" />
            <h2 className="text-sm font-semibold text-text">References</h2>
            <span className="ml-auto font-mono text-[10px] text-faint">Last reviewed {formatDate(meta.lastReviewed)}</span>
          </div>
          <ReferenceList references={module.references} />
        </section>

        <section className="rounded-[16px] border border-border bg-surface p-4">
          <h2 className="text-sm font-semibold text-text">Before and after</h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-faint">Before this</p>
              {meta.prerequisites.length ? (
                <ul className="mt-1 space-y-1 text-sm">
                  {meta.prerequisites.map((id) => {
                    const item = allModules.find((candidate) => candidate.id === id);
                    if (!item) return null;
                    const authored = AUTHORED_BY_SLUG.has(item.slug);
                    return (
                      <li key={id}>
                        {authored ? <Link to={`/modules/${item.slug}`} className="text-accent hover:underline">{item.title}</Link> : <span className="text-muted">{item.title} <Lock aria-label="In authoring" className="inline size-3 text-faint" /></span>}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-muted">No prerequisites. Start here.</p>
              )}
            </div>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-faint">After this</p>
              {after.length ? (
                <ul className="mt-1 space-y-1 text-sm">
                  {after.map((item) => (
                    <li key={item.id} className="text-muted">{item.title}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-muted">Continue with the next module in the track.</p>
              )}
            </div>
          </div>
        </section>
      </div>

      <nav aria-label="Module navigation" className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
        {prev ? (
          AUTHORED_BY_SLUG.has(prev.slug) ? (
            <Link to={`/modules/${prev.slug}`} className="rounded-[12px] border border-border bg-surface p-3 hover:border-faint">
              <span className="font-mono text-[10px] text-faint">Previous</span>
              <span className="mt-0.5 flex items-center gap-1 text-sm text-text"><ArrowLeft aria-hidden="true" className="size-4" /> {prev.title}</span>
            </Link>
          ) : (
            <div className="rounded-[12px] border border-dashed border-border p-3 text-sm text-faint">Previous: {prev.title} (in authoring)</div>
          )
        ) : <span />}
        {next ? (
          AUTHORED_BY_SLUG.has(next.slug) ? (
            <Link to={`/modules/${next.slug}`} className="rounded-[12px] border border-border bg-surface p-3 text-right hover:border-faint sm:col-start-2">
              <span className="font-mono text-[10px] text-faint">Next</span>
              <span className="mt-0.5 flex items-center justify-end gap-1 text-sm text-text">{next.title} <ArrowRight aria-hidden="true" className="size-4" /></span>
            </Link>
          ) : (
            <div className="rounded-[12px] border border-dashed border-border p-3 text-right text-sm text-faint">Next: {next.title} (in authoring)</div>
          )
        ) : null}
      </nav>
    </article>
  );
}
