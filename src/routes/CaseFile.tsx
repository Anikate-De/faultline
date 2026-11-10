import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, FileWarning } from "lucide-react";
import { MODULE_BY_ID, MODULE_BY_SLUG, caseFileKind } from "@/content/manifest";
import type { ManifestModule } from "@/content/manifest";
import type { CaseStudy, ModuleMeta } from "@/content/types";
import { hasAuthoredCase, loadCaseFile } from "@/case-files/registry";
import { CaseFileView } from "@/case-files/CaseStudyView";
import { Badge } from "@/components/ui/Badge";
import { EmptyState, RouteFallback } from "@/components/ui/Feedback";
import NotFound from "./NotFound";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; slug: string; meta: ModuleMeta; caseStudy: CaseStudy }
  | { status: "error" };

function PlannedCaseFile({ module }: { module: ManifestModule }) {
  const kind = caseFileKind(module);
  return (
    <div className="mx-auto max-w-3xl space-y-5 py-2">
      <Link to="/case-files" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
        <ArrowLeft aria-hidden="true" className="size-4" /> Case files
      </Link>
      <header className="rounded-[16px] border border-border bg-surface p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={kind === "real" ? "info" : "interview"}>{kind === "real" ? "Public incident candidate" : "Composite scenario"}</Badge>
          <Badge>{module.caseFile}</Badge>
          <Badge tone="warn">In authoring</Badge>
        </div>
        <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">{module.title}</h1>
        <p className="mt-2 text-base text-muted">{module.productionQuestion}</p>
        <p className="mt-3 rounded-md border border-border bg-raised p-3 text-xs leading-relaxed text-muted">
          {kind === "real"
            ? "This case file is planned from a public incident. Dates, impact, and telemetry will be verified against the public postmortem before authoring. Nothing on this page is a factual claim about the incident."
            : "This is an original composite scenario, clearly labeled. It is not a real company incident and does not describe any organization's internals."}
        </p>
      </header>

      <EmptyState
        icon={<FileWarning aria-hidden="true" className="size-5" />}
        title="This case file is planned, not authored"
        body="The manifest defines its purpose, incident class, decision points, and sources plan. The authored case file will add a verified timeline, illustrative telemetry snapshots, decisions with consequences, and a replay sim."
        action={
          <Link to={`/tracks/${module.prerequisites[0] ? (MODULE_BY_ID.get(module.prerequisites[0])?.track ?? "case-files") : "case-files"}`} className="text-sm text-accent hover:underline">
            Study the prerequisite modules
          </Link>
        }
      />

      <section className="rounded-[16px] border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">Planned structure</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>The setup: architecture and normal behavior.</li>
          <li>The trigger: a scrubbable timeline.</li>
          <li>The signals: illustrative telemetry snapshots.</li>
          <li>Decision points: options, consequences, hidden debriefs.</li>
          <li>The replay: an interactive simulation.</li>
          <li>The postmortem: what changed and what generalizes.</li>
          <li>Sources and accuracy note.</li>
        </ol>
        <p className="mt-3 text-xs text-faint">
          Sources are verified against public postmortems during authoring. Prerequisites:{" "}
          {module.prerequisites.map((id) => MODULE_BY_ID.get(id)?.title ?? id).join(", ") || "none"}.
        </p>
      </section>
    </div>
  );
}

export default function CaseFile() {
  const { slug } = useParams();
  const module = slug ? MODULE_BY_SLUG.get(slug) : undefined;
  const authored = slug ? hasAuthoredCase(slug) : false;
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!slug || !hasAuthoredCase(slug)) return;
    let cancelled = false;
    loadCaseFile(slug)
      .then((loaded) => {
        if (!cancelled) setState({ status: "ready", slug, ...loaded });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (module) document.title = `${module.title} — Faultline`;
    return () => {
      document.title = "Faultline — An interactive SRE and DevOps field lab";
    };
  }, [module]);

  if (!module || module.track !== "case-files") return <NotFound />;
  if (authored && state.status === "loading") return <RouteFallback />;
  if (authored && state.status === "error") return <NotFound />;
  if (authored && state.status === "ready" && state.slug === slug) {
    return (
      <div className="space-y-5">
        <Link to="/case-files" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
          <ArrowLeft aria-hidden="true" className="size-4" /> Case files
        </Link>
        <CaseFileView meta={state.meta} study={state.caseStudy} />
      </div>
    );
  }
  return <PlannedCaseFile module={module} />;
}
