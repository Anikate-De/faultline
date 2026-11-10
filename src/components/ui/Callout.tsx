import { useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Copy, Info, Lightbulb, MessageSquareQuote, XCircle } from "lucide-react";
import type { Tone } from "@/content/types";
import { cn } from "@/lib/format";
import { Button } from "./Button";

const tone = {
  info: { icon: Info, className: "tone-info" },
  warn: { icon: AlertTriangle, className: "tone-warn" },
  danger: { icon: XCircle, className: "tone-danger" },
  success: { icon: CheckCircle2, className: "tone-success" },
  interview: { icon: MessageSquareQuote, className: "tone-interview" },
} satisfies Record<Tone, { icon: typeof Info; className: string }>;

const toneStyles: Record<Tone, string> = {
  info: "bg-[var(--tone-info-bg)] border-[var(--tone-info-border)]",
  warn: "bg-[var(--tone-warn-bg)] border-[var(--tone-warn-border)]",
  danger: "bg-[var(--tone-danger-bg)] border-[var(--tone-danger-border)]",
  success: "bg-[var(--tone-success-bg)] border-[var(--tone-success-border)]",
  interview: "bg-[var(--tone-interview-bg)] border-[var(--tone-interview-border)]",
};

const toneText: Record<Tone, string> = {
  info: "text-info",
  warn: "text-warn",
  danger: "text-danger",
  success: "text-success",
  interview: "text-[var(--interview)]",
};

export function Callout({
  tone: t = "info",
  title,
  children,
}: {
  tone?: Tone;
  title: string;
  children: ReactNode;
}) {
  const Icon = tone[t].icon;
  return (
    <aside className={cn("rounded-[12px] border p-4", toneStyles[t])}>
      <div className={cn("mb-1 flex items-center gap-2 text-sm font-semibold", toneText[t])}>
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        {title}
      </div>
      <div className="text-sm leading-relaxed text-muted">{children}</div>
    </aside>
  );
}

export function CodeBlock({
  code,
  title,
  caption,
  language = "text",
}: {
  code: string;
  title?: string;
  caption?: string;
  language?: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }
  return (
    <figure className="overflow-hidden rounded-[12px] border border-border bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-raised px-3 py-2">
        <figcaption className="min-w-0 truncate font-mono text-xs text-muted">
          {title ?? language}
        </figcaption>
        <Button size="sm" variant="ghost" onClick={copy} aria-label="Copy code">
          <Copy aria-hidden="true" className="size-4" />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre tabIndex={0} aria-label={title ?? "Code sample"} className="max-w-full overflow-x-auto p-4 text-[13px] leading-relaxed">
        <code>{code}</code>
      </pre>
      {caption ? <p className="border-t border-border px-4 py-2 text-xs text-muted">{caption}</p> : null}
    </figure>
  );
}

export function Tip({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside className="rounded-[12px] border border-border bg-surface p-4">
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-text">
        <Lightbulb aria-hidden="true" className="size-4 text-accent" />
        {title}
      </div>
      <div className="text-sm leading-relaxed text-muted">{children}</div>
    </aside>
  );
}
