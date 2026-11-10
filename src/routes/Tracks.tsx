import { Link } from "react-router-dom";
import { ArrowRight, ListTree, Lock } from "lucide-react";
import { TRACKS } from "@/content/tracks";
import { useAppStore } from "@/lib/store";
import { pluralize } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { ProgressRing } from "@/components/ui/Progress";

export default function Tracks() {
  const completed = useAppStore((s) => s.completed);
  return (
    <div className="space-y-6">
      <header className="max-w-3xl">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent">Curriculum</p>
        <h1 className="mt-1">Tracks</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Fifteen tracks, ordered by dependency. Prerequisites are guidance, not locks. Case files slot between
          modules where a real incident fits.
        </p>
        <Link to="/curriculum" className="mt-3 inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
          <ListTree aria-hidden="true" className="size-4" /> View the flat all-module path with case-file milestones
        </Link>
      </header>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {TRACKS.map((track) => {
          const done = Object.keys(completed).filter((id) => id.startsWith(track.id === "case-files" ? "case-" : `${track.id}-`)).length;
          const percent = track.planned ? Math.round((done / track.planned) * 100) : 0;
          return (
            <Link
              key={track.id}
              to={`/tracks/${track.id}`}
              className="group flex flex-col rounded-[16px] border border-border bg-surface p-5 transition-colors hover:border-faint"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-text">{track.title}</h2>
                  <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-faint">
                    {track.planned ? pluralize(track.planned, "module") : "Reserved"}
                  </p>
                </div>
                {track.reserved ? <Badge tone="interview">Later</Badge> : <ProgressRing value={percent} size={44} />}
              </div>
              <p className="mt-3 flex-1 text-sm leading-relaxed text-muted">{track.description}</p>
              <div className="mt-4 flex items-center justify-between text-xs">
                <span className="font-mono text-[10px] text-faint">{done} completed</span>
                <span className="inline-flex items-center gap-1 text-accent">
                  {track.reserved ? "Preview" : "Open track"} <ArrowRight aria-hidden="true" className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </div>
            </Link>
          );
        })}
      </div>
      <div className="flex items-start gap-3 rounded-[16px] border border-dashed border-border bg-surface p-4 text-sm text-muted">
        <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-faint" />
        <p>
          Kubernetes is reserved for a later build. The track is intentionally empty; it will start from a clean
          baseline rather than arrive as a bolt-on to this one.
        </p>
      </div>
    </div>
  );
}
