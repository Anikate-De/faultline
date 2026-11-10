import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, History, Lightbulb, RefreshCcw, Sparkles } from "lucide-react";
import { DRILLS } from "@/content/drills";
import { AUTHORED_BY_SLUG } from "@/modules/registry";
import { MODULE_BY_ID } from "@/content/manifest";
import { confidenceLabel, dueReviews, useAppStore } from "@/lib/store";
import { formatDate, pluralize } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/Feedback";
import { RevealPanel } from "@/components/ui/Reveal";
import { ProgressRing } from "@/components/ui/Progress";

export default function Review() {
  const reviews = useAppStore((s) => s.reviews);
  const confidence = useAppStore((s) => s.confidence);
  const due = dueReviews();
  const [drillIndex, setDrillIndex] = useState(0);
  const drill = DRILLS[drillIndex % DRILLS.length];
  const drillModule = MODULE_BY_ID.get(drill.moduleId);
  const rated = Object.entries(confidence).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-6">
      <header className="max-w-3xl">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent">Spaced review</p>
        <h1 className="mt-1">Review</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Confidence ratings schedule reviews at 1, 3, 7, and 21 days. Answers stay hidden until you reveal them.
          If the queue is empty, rate your confidence on a completed module.
        </p>
      </header>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-[16px] border border-border bg-surface p-4">
          <div className="flex items-center gap-3">
            <ProgressRing value={due.length ? Math.max(10, 100 - due.length * 10) : 0} size={48} label={`${due.length} reviews due`} />
            <div>
              <p className="font-mono text-2xl text-text">{due.length}</p>
              <p className="text-xs text-muted">due now</p>
            </div>
          </div>
          <p className="mt-3 text-xs text-faint">{Object.keys(reviews).length} modules in the review queue.</p>
        </div>
        <div className="rounded-[16px] border border-border bg-surface p-4 lg:col-span-2">
          <div className="flex items-center gap-2">
            <History aria-hidden="true" className="size-4 text-accent" />
            <h2 className="text-sm font-semibold text-text">Due modules</h2>
          </div>
          {due.length ? (
            <ul className="mt-3 space-y-2">
              {due.map((item) => {
                const module = MODULE_BY_ID.get(item.moduleId);
                return (
                  <li key={item.moduleId} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-text">{module?.title ?? item.moduleId}</span>
                    <Badge tone="warn">Due {formatDate(item.due)}</Badge>
                    <span className="font-mono text-[10px] text-faint">{confidenceLabel(item.confidence)}</span>
                    {module && AUTHORED_BY_SLUG.has(module.slug) ? (
                      <Link to={`/modules/${module.slug}`} className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                        Open <ArrowRight aria-hidden="true" className="size-3" />
                      </Link>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted">
              Nothing is due. Rate confidence in a module to add it. The first review is scheduled for tomorrow.
            </p>
          )}
        </div>
      </section>

      <section className="rounded-[16px] border border-border bg-surface p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="interview">
            <Sparkles aria-hidden="true" className="size-3" />
            Random drill
          </Badge>
          <Button size="sm" variant="ghost" onClick={() => setDrillIndex((index) => index + 1)}>
            <RefreshCcw aria-hidden="true" className="size-4" />
            Another question
          </Button>
        </div>
        <p className="mt-3 text-sm font-medium leading-relaxed text-text">{drill.question}</p>
        <div className="mt-3">
          <RevealPanel label="Model answer" tone="interview" hint="Answer out loud before revealing.">
            <p>{drill.answer}</p>
            <p className="mt-2 text-xs text-faint">
              Hints: {drill.hints.join(" ")}
            </p>
          </RevealPanel>
        </div>
        {drillModule && AUTHORED_BY_SLUG.has(drillModule.slug) ? (
          <Link to={`/modules/${drillModule.slug}#interview`} className="mt-3 inline-flex items-center gap-1 text-xs text-accent hover:underline">
            Open the full drill <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        ) : null}
      </section>

      <section className="rounded-[16px] border border-border bg-surface p-5">
        <div className="flex items-center gap-2">
          <Lightbulb aria-hidden="true" className="size-4 text-accent" />
          <h2 className="text-sm font-semibold text-text">Confidence history</h2>
        </div>
        {rated.length ? (
          <div className="mt-3 space-y-2">
            {rated.map(([moduleId, rating]) => {
              const module = MODULE_BY_ID.get(moduleId);
              const review = reviews[moduleId];
              return (
                <div key={moduleId} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate text-sm text-muted">{module?.title ?? moduleId}</span>
                  <span className="font-mono text-[10px] text-faint">{confidenceLabel(rating)}</span>
                  <span className="h-1.5 w-24 overflow-hidden rounded-full bg-raised">
                    <span className="block h-full rounded-full bg-accent" style={{ width: `${rating * 20}%` }} />
                  </span>
                  {review ? <span className="text-faint">next {formatDate(review.due)}</span> : null}
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="No confidence ratings yet"
            body="Open a module, finish the interview drill, and rate confidence 1–5. Faultline schedules the next review and keeps the answer hidden until you reveal it."
            action={
              <Link to="/" className="text-sm text-accent hover:underline">
                Find a module
              </Link>
            }
          />
        )}
        <p className="mt-3 text-[10px] text-faint">{pluralize(rated.length, "module")} rated.</p>
      </section>
    </div>
  );
}
