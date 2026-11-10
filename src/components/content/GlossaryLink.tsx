import { useState, type ReactNode } from "react";
import { GlossaryTooltip as Tooltip } from "./GlossaryTooltip";

export function GlossaryTooltip({ termId, children }: { termId: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="cursor-help border-b border-dotted border-accent/60 text-inherit hover:text-accent"
      >
        {children}
      </button>
      <Tooltip termId={termId} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
