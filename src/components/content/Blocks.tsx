import { Fragment, type ReactNode } from "react";
import { CheckCircle2, ExternalLink, Quote } from "lucide-react";
import type { Block, Tone } from "@/content/types";
import { GLOSSARY_BY_ID } from "@/content/glossary";
import { cn } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Callout, CodeBlock } from "@/components/ui/Callout";
import { DiagramFrame } from "./DiagramFrame";
import { GlossaryTooltip } from "./GlossaryLink";

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function inline(text: string): ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  const parts = text.split(pattern);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index} className="rounded bg-raised px-1 py-0.5 font-mono text-[0.9em] text-accent">{part.slice(1, -1)}</code>;
    }
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (link) {
      return (
        <a key={index} href={link[2]} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">
          {link[1]}
        </a>
      );
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

const toneMap: Record<Tone, "info" | "warn" | "danger" | "success" | "interview"> = {
  info: "info",
  warn: "warn",
  danger: "danger",
  success: "success",
  interview: "interview",
};

function TableBlock({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="min-w-0">
      <div className="hidden overflow-x-auto rounded-[12px] border border-border md:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-raised">
            <tr>
              {headers.map((header) => (
                <th key={header} scope="col" className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.06em] text-muted">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="border-t border-border">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="px-3 py-2 text-muted">
                    {inline(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-2 md:hidden">
        {rows.map((row, index) => (
          <dl key={index} className="rounded-[12px] border border-border bg-surface p-3">
            {row.map((cell, cellIndex) => (
              <div key={cellIndex} className={cn("grid grid-cols-[minmax(0,35%)_1fr] gap-2 py-1", cellIndex > 0 && "border-t border-border")}>
                <dt className="text-[10px] uppercase tracking-[0.06em] text-faint">{headers[cellIndex] ?? ""}</dt>
                <dd className="text-sm text-muted">{inline(cell)}</dd>
              </div>
            ))}
          </dl>
        ))}
      </div>
    </div>
  );
}

export function BlockRenderer({ blocks }: { blocks: Block[] }) {
  return (
    <div className="prose-measure space-y-4">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "p":
            return (
              <p key={index} className="text-[15px] leading-relaxed text-muted sm:text-base">
                {inline(block.text)}
              </p>
            );
          case "h2":
            return (
              <h2 key={index} id={block.id ?? slugify(block.text)} className="scroll-mt-24 pt-3 text-xl font-semibold text-text">
                {inline(block.text)}
              </h2>
            );
          case "h3":
            return (
              <h3 key={index} className="pt-1 text-base font-semibold text-text">
                {inline(block.text)}
              </h3>
            );
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag key={index} className={cn("space-y-1.5 pl-5 text-[15px] leading-relaxed text-muted", block.ordered ? "list-decimal" : "list-disc")}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{inline(item)}</li>
                ))}
              </Tag>
            );
          }
          case "callout":
            return (
              <Callout key={index} tone={toneMap[block.tone]} title={block.title}>
                {inline(block.body)}
              </Callout>
            );
          case "compare":
            return (
              <div key={index} className="overflow-hidden rounded-[12px] border border-border">
                <div className="hidden grid-cols-[minmax(0,0.8fr)_1fr_1fr] bg-raised md:grid">
                  <span className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.06em] text-faint">Aspect</span>
                  <span className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.06em] text-info">{block.leftTitle}</span>
                  <span className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.06em] text-accent">{block.rightTitle}</span>
                </div>
                {block.rows.map((row, rowIndex) => (
                  <div key={rowIndex} className="grid gap-2 border-t border-border p-3 text-sm md:grid-cols-[minmax(0,0.8fr)_1fr_1fr] md:gap-0 md:p-0">
                    <span className="font-medium text-text md:px-3 md:py-2">{row.label}</span>
                    <span className="text-muted md:px-3 md:py-2">
                      <span className="mr-1 font-mono text-[10px] text-info md:hidden">{block.leftTitle}:</span>
                      {inline(row.left)}
                    </span>
                    <span className="text-muted md:px-3 md:py-2">
                      <span className="mr-1 font-mono text-[10px] text-accent md:hidden">{block.rightTitle}:</span>
                      {inline(row.right)}
                    </span>
                  </div>
                ))}
              </div>
            );
          case "code":
            return <CodeBlock key={index} code={block.code} title={block.title} caption={block.caption} language={block.language} />;
          case "diagram":
            return <DiagramFrame key={index} id={block.id} caption={block.caption} />;
          case "metrics":
            return (
              <div key={index} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {block.items.map((item) => (
                  <div key={item.label} className="rounded-[10px] border border-border bg-surface p-3">
                    <p className="text-[10px] uppercase tracking-[0.06em] text-faint">{item.label}</p>
                    <p className={cn("mt-1 font-mono text-lg", item.tone === "danger" ? "text-danger" : item.tone === "warn" ? "text-warn" : item.tone === "success" ? "text-success" : "text-text")}>
                      {item.value}
                    </p>
                  </div>
                ))}
              </div>
            );
          case "timeline":
            return (
              <ol key={index} className="space-y-3 border-l border-border pl-4">
                {block.events.map((event, eventIndex) => (
                  <li key={eventIndex} className="relative">
                    <span aria-hidden="true" className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-accent" />
                    <p className="font-mono text-[10px] text-faint">{event.at}</p>
                    <p className="text-sm font-medium text-text">{event.title}</p>
                    <p className="text-sm text-muted">{inline(event.body)}</p>
                  </li>
                ))}
              </ol>
            );
          case "checklist":
            return (
              <div key={index} className="rounded-[12px] border border-border bg-surface p-4">
                {block.title ? <h3 className="mb-2 text-sm font-semibold text-text">{block.title}</h3> : null}
                <ul className="space-y-2">
                  {block.items.map((item) => (
                    <li key={item} className="flex gap-2 text-sm text-muted">
                      <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
                      {inline(item)}
                    </li>
                  ))}
                </ul>
              </div>
            );
          case "glossary":
            return (
              <div key={index} className="flex flex-wrap gap-2">
                {block.termIds.map((termId) => {
                  const term = GLOSSARY_BY_ID.get(termId);
                  return (
                    <span key={termId} className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted">
                      <GlossaryTooltip termId={termId}>{term?.term ?? termId}</GlossaryTooltip>
                    </span>
                  );
                })}
              </div>
            );
          case "quote":
            return (
              <figure key={index} className="rounded-[12px] border border-border bg-surface p-4">
                <Quote aria-hidden="true" className="size-4 text-accent" />
                <blockquote className="mt-1 text-sm italic text-text">{block.text}</blockquote>
                {block.attribution ? (
                  <figcaption className="mt-2 text-xs text-muted">
                    {block.attribution}
                    {block.source ? `, ${block.source}` : ""}
                  </figcaption>
                ) : null}
              </figure>
            );
          case "table":
            return <TableBlock key={index} headers={block.headers} rows={block.rows} />;
          case "sim":
          case "experiment":
            return null;
          default:
            return (
              <div key={index} className="rounded-[12px] border border-dashed border-border p-3 text-sm text-muted">
                Custom block unavailable.
              </div>
            );
        }
      })}
    </div>
  );
}

export function ReferenceList({
  references,
}: {
  references: { title: string; url: string; publisher: string; kind: string; note?: string }[];
}) {
  return (
    <ul className="space-y-2">
      {references.map((reference) => (
        <li key={reference.url} className="rounded-[10px] border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={reference.kind === "postmortem" ? "warn" : "info"}>{reference.kind}</Badge>
            <a
              href={reference.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm font-medium text-text hover:text-accent"
            >
              {reference.title} <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          </div>
          <p className="mt-1 text-xs text-muted">{reference.publisher}{reference.note ? ` · ${reference.note}` : ""}</p>
        </li>
      ))}
    </ul>
  );
}
