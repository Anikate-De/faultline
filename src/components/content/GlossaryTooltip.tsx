import { GLOSSARY_BY_ID } from "@/content/glossary";
import { Dialog } from "@/components/ui/Controls";

export function GlossaryTooltip({
  termId,
  open,
  onClose,
}: {
  termId: string;
  open: boolean;
  onClose: () => void;
}) {
  const term = GLOSSARY_BY_ID.get(termId);
  return (
    <Dialog open={open} onClose={onClose} title={term?.term ?? "Glossary"}>
      {term ? (
        <div className="space-y-3 text-sm leading-relaxed text-muted">
          <p className="text-text">{term.short}</p>
          <p>{term.body}</p>
          <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-faint">Track: {term.track}</p>
          {term.related?.length ? (
            <p>
              Related:{" "}
              {term.related
                .map((id) => GLOSSARY_BY_ID.get(id)?.term)
                .filter(Boolean)
                .join(", ")}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted">This term is not in the glossary yet.</p>
      )}
    </Dialog>
  );
}
