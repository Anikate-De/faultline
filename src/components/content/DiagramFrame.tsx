import { DIAGRAMS } from "@/content/diagrams";

export function DiagramFrame({
  id,
  caption,
  title,
}: {
  id: string;
  caption?: string;
  title?: string;
}) {
  const diagram = DIAGRAMS[id];
  return (
    <figure className="min-w-0 overflow-hidden rounded-[16px] border border-border bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-raised px-4 py-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
          {title ?? "Diagram"}
        </span>
        <span className="font-mono text-[11px] text-faint">{id}</span>
      </div>
      <div tabIndex={0} role="group" aria-label={`${title ?? "Diagram"} scrollable`} className="min-w-0 overflow-x-auto p-3 sm:p-4">
        {diagram ?? (
          <div className="rounded-[10px] border border-dashed border-border p-6 text-center text-sm text-muted">
            Diagram unavailable.
          </div>
        )}
      </div>
      <p className="px-4 pb-2 text-[10px] text-faint sm:hidden">Scroll the diagram horizontally to see the full path.</p>
      {caption ? (
        <figcaption className="border-t border-border px-4 py-2 text-xs text-muted">{caption}</figcaption>
      ) : null}
    </figure>
  );
}
