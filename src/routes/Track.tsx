import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Filter, Lock, Search } from "lucide-react";
import { TRACK_BY_ID, TRACKS } from "@/content/tracks";
import { MODULE_BY_ID, modulesForTrack } from "@/content/manifest";
import { AUTHORED_BY_SLUG } from "@/modules/registry";
import { useAppStore } from "@/lib/store";
import { pluralize } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Input, SegmentedControl } from "@/components/ui/Controls";
import { ProgressRing } from "@/components/ui/Progress";
import { ModuleCard } from "@/components/layout/Cards";
import NotFound from "./NotFound";

export default function Track() {
  const { trackId } = useParams();
  const track = trackId ? TRACK_BY_ID.get(trackId as never) : undefined;
  const completed = useAppStore((s) => s.completed);
  const [difficulty, setDifficulty] = useState<"all" | "1" | "2" | "3" | "4">("all");
  const [filter, setFilter] = useState("");
  const modules = useMemo(() => (track ? modulesForTrack(track.id) : []), [track]);
  const done = modules.filter((m) => completed[m.id]).length;
  const percent = track?.planned ? Math.round((done / track.planned) * 100) : 0;
  const filtered = modules.filter((module) => {
    if (difficulty !== "all" && module.difficulty !== Number(difficulty)) return false;
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return (
      module.title.toLowerCase().includes(q) ||
      module.productionQuestion.toLowerCase().includes(q) ||
      module.learningDelta.toLowerCase().includes(q) ||
      module.concepts.some((c) => c.toLowerCase().includes(q))
    );
  });

  if (!track) return <NotFound />;

  if (track.reserved) {
    return (
      <div className="mx-auto max-w-2xl space-y-5 py-6">
        <Link to="/tracks" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
          <ArrowLeft aria-hidden="true" className="size-4" /> All tracks
        </Link>
        <div className="rounded-[16px] border border-dashed border-border bg-surface p-6">
          <Badge tone="interview">Reserved</Badge>
          <h1 className="mt-3 text-2xl font-semibold">Kubernetes</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">{track.description}</p>
          <p className="mt-3 rounded-md border border-border bg-raised p-3 text-sm text-muted">
            This track is intentionally empty. You will learn Kubernetes from a clean baseline, not as a bolt-on
            to this build. The architecture already supports adding it as a new track with new modules and models.
          </p>
          <Link to="/tracks" className="mt-4 inline-flex text-sm text-accent hover:underline">
            Back to the curriculum
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Link to="/tracks" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
        <ArrowLeft aria-hidden="true" className="size-4" /> All tracks
      </Link>
      <header className="rounded-[16px] border border-border bg-surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent">Track</p>
            <h1 className="mt-1 text-2xl font-semibold sm:text-3xl">{track.title}</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted">{track.description}</p>
            <div className="mt-3 flex flex-wrap gap-2 font-mono text-[10px] text-faint">
              <span>{pluralize(track.planned, "planned module")}</span>
              <span aria-hidden="true">·</span>
              <span>{done} completed</span>
              <span aria-hidden="true">·</span>
              <span>{track.purpose}</span>
            </div>
          </div>
          <ProgressRing value={percent} size={64} label={`${track.title}: ${percent} percent complete`} />
        </div>
      </header>

      <div className="flex flex-col gap-3 rounded-[12px] border border-border bg-surface p-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="track-filter" className="mb-1 block text-xs font-medium text-muted">
            Filter modules
          </label>
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-3.5 size-4 text-faint" />
            <Input
              id="track-filter"
              label=""
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Title, concept, or question"
              aria-label="Filter modules by title, concept, or question"
              className="pl-9"
            />
          </div>
        </div>
        <div className="sm:w-64">
          <SegmentedControl
            label="Difficulty"
            value={difficulty}
            onChange={setDifficulty}
            options={[
              { value: "all", label: "All" },
              { value: "1", label: "1" },
              { value: "2", label: "2" },
              { value: "3", label: "3" },
              { value: "4", label: "4" },
            ]}
          />
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted">
        <Filter aria-hidden="true" className="size-4 text-faint" />
        {filtered.length} of {modules.length} modules
        {filter ? ` matching “${filter}”` : ""}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-[16px] border border-dashed border-border bg-surface p-6 text-center text-sm text-muted">
          No modules match this filter. Try a broader concept or clear the difficulty filter.
        </div>
      ) : (
        <ol className="space-y-3">
          {filtered.map((module, index) => {
            const authored = AUTHORED_BY_SLUG.has(module.slug);
            const showSlot = (index + 1) % 6 === 0 && index + 1 < filtered.length;
            return (
              <li key={module.id} className="space-y-3">
                <div className="flex items-start gap-2">
                  <span className="mt-3 hidden w-6 shrink-0 text-right font-mono text-[10px] text-faint sm:block">
                    {module.order}
                  </span>
                  <div className="min-w-0 flex-1">
                    <ModuleCard module={module} authored={authored} />
                    {module.prerequisites.length ? (
                      <p className="mt-1 px-1 text-[10px] text-faint">
                        Before this:{" "}
                        {module.prerequisites
                          .map((id) => MODULE_BY_ID.get(id)?.title ?? id)
                          .join(", ")}
                      </p>
                    ) : null}
                  </div>
                </div>
                {showSlot ? (
                  <div className="ml-0 flex items-center gap-2 rounded-[10px] border border-dashed border-border bg-surface px-3 py-2 text-xs text-muted sm:ml-8">
                    <Lock aria-hidden="true" className="size-3.5 text-faint" />
                    Case file slot. Public incidents slot here as they are authored.
                    <Link to="/case-files" className="ml-auto text-accent hover:underline">
                      Case files
                    </Link>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        {TRACKS.filter((item) => !item.reserved && item.id !== track.id)
          .slice(0, 4)
          .map((item) => (
            <Link key={item.id} to={`/tracks/${item.id}`} className="rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-muted hover:text-text">
              {item.short}
            </Link>
          ))}
      </div>
    </div>
  );
}
