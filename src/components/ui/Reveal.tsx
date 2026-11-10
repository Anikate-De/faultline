import { useId, useState, type ReactNode } from "react";
import { Check, ChevronDown, Eye, EyeOff, Lightbulb } from "lucide-react";
import { cn } from "@/lib/format";
import { Button } from "./Button";

export function RevealPanel({
  label,
  children,
  hint,
  tone = "default",
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  tone?: "default" | "interview";
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div
      className={cn(
        "rounded-[12px] border p-3",
        tone === "interview"
          ? "border-[var(--tone-interview-border)] bg-[var(--tone-interview-bg)]"
          : "border-border bg-surface",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className={cn("text-sm font-semibold", tone === "interview" ? "text-[var(--interview)]" : "text-text")}>
            {label}
          </p>
          {hint ? <p className="mt-0.5 text-xs text-muted">{hint}</p> : null}
        </div>
        <Button
          size="sm"
          variant={tone === "interview" ? "interview" : "secondary"}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
          {open ? "Hide" : "Reveal"}
        </Button>
      </div>
      {open ? (
        <div id={id} className="mt-3 border-t border-border pt-3 text-sm leading-relaxed text-muted">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export interface PredictionOption {
  id: string;
  label: string;
}

export function PredictionPicker({
  options,
  value,
  onChange,
  correctId,
  revealed,
  question,
  explanation,
}: {
  options: PredictionOption[];
  value: string;
  onChange: (id: string) => void;
  correctId: string;
  revealed: boolean;
  question: string;
  explanation: string;
}) {
  const pickerId = useId();
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium text-text">{question}</legend>
      <div role="radiogroup" aria-label={question} className="grid gap-2 sm:grid-cols-2">
        {options.map((option, index) => {
          const selected = value === option.id;
          const isCorrect = revealed && option.id === correctId;
          const isWrong = revealed && selected && option.id !== correctId;
          return (
            <button
              key={option.id}
              id={`${pickerId}-${option.id}`}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected || (!value && index === 0) ? 0 : -1}
              onKeyDown={(event) => {
                if (revealed) return;
                const current = options.findIndex((item) => item.id === value);
                const start = current === -1 ? 0 : current;
                let next: number;
                if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (start + 1) % options.length;
                else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (start - 1 + options.length) % options.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = options.length - 1;
                else return;
                event.preventDefault();
                onChange(options[next].id);
                document.getElementById(`${pickerId}-${options[next].id}`)?.focus();
              }}
              onClick={() => {
                if (!revealed) onChange(option.id);
              }}
              disabled={revealed}
              className={cn(
                "flex min-h-11 items-center justify-between gap-2 rounded-[10px] border px-3 py-2 text-left text-sm transition-colors",
                selected && !revealed && "border-accent bg-[var(--tone-info-bg)] text-text",
                !selected && !revealed && "border-border bg-surface text-muted hover:border-faint hover:text-text",
                isCorrect && "border-[var(--tone-success-border)] bg-[var(--tone-success-bg)] text-success",
                isWrong && "border-[var(--tone-danger-border)] bg-[var(--tone-danger-bg)] text-danger",
                revealed && !isCorrect && !isWrong && "border-border bg-surface text-faint",
              )}
            >
              <span>{option.label}</span>
              {isCorrect ? <Check aria-hidden="true" className="size-4 shrink-0" /> : null}
            </button>
          );
        })}
      </div>
      {revealed ? (
        <div className="mt-3 rounded-[10px] border border-border bg-raised p-3 text-sm leading-relaxed text-muted">
          <span className="font-medium text-text">{value === correctId ? "Correct. " : "Not quite. "}</span>
          {explanation}
        </div>
      ) : null}
    </fieldset>
  );
}

export function HintList({ hints }: { hints: string[] }) {
  const [shown, setShown] = useState(0);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShown((value) => Math.min(hints.length, value + 1))}
          disabled={shown >= hints.length}
        >
          <Lightbulb aria-hidden="true" className="size-4" />
          {shown === 0 ? "Show a hint" : `Next hint (${shown}/${hints.length})`}
        </Button>
        {shown > 0 ? <span className="text-xs text-faint">Hints stay hidden from the model answer.</span> : null}
      </div>
      {shown > 0 ? (
        <ol className="space-y-1.5 rounded-[10px] border border-border bg-surface p-3 text-sm text-muted">
          {hints.slice(0, shown).map((hint) => (
            <li key={hint} className="flex gap-2">
              <ChevronDown aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-accent" />
              {hint}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

export function Quiz({
  question,
  options,
  correctId,
  explanation,
}: {
  question: string;
  options: PredictionOption[];
  correctId: string;
  explanation: string;
}) {
  const [selected, setSelected] = useState("");
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="space-y-2">
      <PredictionPicker
        question={question}
        options={options}
        value={selected}
        onChange={setSelected}
        correctId={correctId}
        revealed={revealed}
        explanation={explanation}
      />
      <Button size="sm" disabled={!selected || revealed} onClick={() => setRevealed(true)}>
        Check answer
      </Button>
    </div>
  );
}
