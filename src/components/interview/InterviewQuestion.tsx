import { useState } from "react";
import { CheckCircle2, MessageSquare, RefreshCcw } from "lucide-react";
import type { InterviewQuestion as InterviewQuestionType } from "@/content/types";
import { confidenceLabel, useAppStore } from "@/lib/store";

import { cn } from "@/lib/format";
import { Badge, DifficultyBadge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { HintList, RevealPanel } from "@/components/ui/Reveal";

export function ConfidencePicker({ moduleId, compact = false }: { moduleId: string; compact?: boolean }) {
  const confidence = useAppStore((s) => s.confidence[moduleId] ?? 0);
  const setConfidence = useAppStore((s) => s.setConfidence);
  return (
    <div className={cn("space-y-1.5", compact && "space-y-1")}>
      <p className="text-xs font-medium uppercase tracking-[0.08em] text-faint">
        Confidence {confidence ? `· ${confidenceLabel(confidence)}` : ""}
      </p>
      <div role="group" aria-label="Rate your confidence" className="flex gap-1">
        {[1, 2, 3, 4, 5].map((rating) => (
          <button
            key={rating}
            type="button"
            aria-label={`Confidence ${rating} of 5: ${confidenceLabel(rating)}`}
            aria-pressed={confidence === rating}
            onClick={() => setConfidence(moduleId, rating)}
            className={cn(
              "flex size-11 items-center justify-center rounded-md border font-mono text-xs transition-colors",
              confidence === rating
                ? "border-accent bg-accent text-[color:var(--accent-contrast)]"
                : "border-border bg-surface text-muted hover:border-faint hover:text-text",
            )}
          >
            {rating}
          </button>
        ))}
      </div>
    </div>
  );
}

export function InterviewQuestion({ question, index }: { question: InterviewQuestionType; index: number }) {
  const interviewMode = useAppStore((s) => s.interviewMode);
  const [explainOpen, setExplainOpen] = useState(false);
  return (
    <article className="rounded-[16px] border border-border bg-surface p-4 sm:p-5" data-interview-question>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-faint">Q{index + 1}</span>
        <DifficultyBadge value={question.difficulty} />
        {interviewMode ? <Badge tone="interview">Interview mode</Badge> : null}
      </div>
      <h3 className="text-base font-semibold leading-snug text-text">{question.question}</h3>
      <div className="mt-3">
        <HintList hints={question.hints} />
      </div>
      <div className="mt-3">
        <RevealPanel
          label="Model answer"
          tone="interview"
          hint="Write or say your answer first. Then reveal."
        >
          <p className="whitespace-pre-line text-text">{question.answer}</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <h4 className="mb-1 font-mono text-[11px] uppercase tracking-[0.08em] text-faint">Follow-ups</h4>
              <ul className="space-y-1">
                {question.followUps.map((item) => (
                  <li key={item} className="flex gap-2">
                    <MessageSquare aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-info" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="mb-1 font-mono text-[11px] uppercase tracking-[0.08em] text-faint">Red flags</h4>
              <ul className="space-y-1">
                {question.redFlags.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-danger" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="mt-4">
            <h4 className="mb-1 font-mono text-[11px] uppercase tracking-[0.08em] text-faint">Rubric</h4>
            <ul className="space-y-1">
              {question.rubric.map((item) => (
                <li key={item} className="flex gap-2">
                  <CheckCircle2 aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-success" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </RevealPanel>
      </div>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={explainOpen}
          onClick={() => setExplainOpen((value) => !value)}
        >
          <RefreshCcw aria-hidden="true" className="size-4" />
          {explainOpen ? "Hide explain-it-back" : "Explain it back"}
        </Button>
      </div>
      {explainOpen ? (
        <div className="mt-3 rounded-[10px] border border-border bg-raised p-3 text-sm text-muted">
          <p className="font-medium text-text">Explain it back in 60 seconds.</p>
          <p className="mt-1">
            Name the system, the signal that changed, the first check, the fix, and one tradeoff. If you cannot
            name a tradeoff, the answer is incomplete.
          </p>
        </div>
      ) : null}
    </article>
  );
}
