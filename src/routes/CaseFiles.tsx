import { useState } from "react";
import { FileWarning, ShieldCheck } from "lucide-react";
import { CASE_FILES, caseFileKind } from "@/content/manifest";
import { AUTHORED_CASE_METAS } from "@/case-files/registry";
import { Badge } from "@/components/ui/Badge";
import { SegmentedControl } from "@/components/ui/Controls";
import { CaseFileCard } from "@/components/layout/Cards";
import { Callout } from "@/components/ui/Callout";

export default function CaseFiles() {
  const [filter, setFilter] = useState<"all" | "real" | "composite">("all");
  const shown = CASE_FILES.filter((item) => filter === "all" || caseFileKind(item) === filter);
  const real = CASE_FILES.filter((item) => caseFileKind(item) === "real").length;
  const authored = AUTHORED_CASE_METAS.length;
  return (
    <div className="space-y-6">
      <header className="max-w-3xl">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent">Incident replay</p>
        <h1 className="mt-1">Case files</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Public incidents and clearly labeled composites. Authored case files have a timeline, decision points with
          consequences, a postmortem, and sources. No invented quotes or internal details.
        </p>
        <div className="mt-3 flex flex-wrap gap-2 font-mono text-[10px] text-faint">
          <span>{authored} authored</span>
          <span aria-hidden="true">·</span>
          <span>{CASE_FILES.length - authored} planned</span>
          <span aria-hidden="true">·</span>
          <span>{real} public-incident candidates</span>
          <span aria-hidden="true">·</span>
          <span>{CASE_FILES.length - real} composites</span>
        </div>
      </header>

      <Callout tone="info" title="Planned rows stay plans">
        Authored case files open a full timeline, decision points, postmortem, and sources. Composite scenarios are
        labeled at the top of the page. Until a planned row passes accuracy review, this page shows its plan only.
      </Callout>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-full sm:w-72">
          <SegmentedControl
            label="Type"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "real", label: "Public" },
              { value: "composite", label: "Composite" },
            ]}
          />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <ShieldCheck aria-hidden="true" className="size-4 text-success" />
          Accuracy review required before publish
        </div>
      </div>

      {shown.length ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((module) => (
            <CaseFileCard key={module.id} module={module} />
          ))}
        </div>
      ) : (
        <div className="rounded-[16px] border border-dashed border-border bg-surface p-8 text-center text-sm text-muted">
          <FileWarning aria-hidden="true" className="mx-auto mb-2 size-5 text-faint" />
          No case files match this filter.
        </div>
      )}

      <div className="rounded-[12px] border border-border bg-surface p-4 text-xs text-muted">
        <Badge tone={authored ? "success" : "warn"}>{authored} authored</Badge>
        <p className="mt-2">
          The {CASE_FILES.length}-case-file manifest is frozen. Authored files appear here with a working timeline and decision
          points; planned rows never render as if they were complete.
        </p>
      </div>
    </div>
  );
}
