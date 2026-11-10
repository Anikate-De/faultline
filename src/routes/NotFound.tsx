import { Link } from "react-router-dom";
import { Compass, Search } from "lucide-react";
import { AUTHORED_METAS } from "@/modules/registry";
import { TRACKS } from "@/content/tracks";
import { EmptyState } from "@/components/ui/Feedback";
import { Button } from "@/components/ui/Button";

export default function NotFound() {
  const modules = AUTHORED_METAS.slice(0, 3);
  return (
    <div className="mx-auto max-w-2xl space-y-5 py-6">
      <EmptyState
        icon={<Compass aria-hidden="true" className="size-5" />}
        title="That route is not here"
        body="The link may point to a planned module that has not been authored, or the address may be mistyped. Nothing is blank: pick a route below or open search with ⌘K."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Link to="/"><Button>Home</Button></Link>
            <Link to="/tracks"><Button variant="secondary">Tracks</Button></Link>
            <Link to="/case-files"><Button variant="secondary">Case files</Button></Link>
            <Link to="/glossary"><Button variant="ghost">Glossary</Button></Link>
          </div>
        }
      />
      <section className="rounded-[16px] border border-border bg-surface p-5">
        <div className="flex items-center gap-2">
          <Search aria-hidden="true" className="size-4 text-accent" />
          <h2 className="text-sm font-semibold text-text">Try a track</h2>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {TRACKS.filter((track) => !track.reserved).slice(0, 8).map((track) => (
            <Link key={track.id} to={`/tracks/${track.id}`} className="rounded-full border border-border px-3 py-1.5 text-xs text-muted hover:text-text">
              {track.short}
            </Link>
          ))}
        </div>
        {modules.length ? (
          <>
            <h3 className="mt-4 font-mono text-[10px] uppercase tracking-[0.08em] text-faint">Authored now</h3>
            <ul className="mt-1 space-y-1">
              {modules.map((module) => (
                <li key={module.id}>
                  <Link to={`/modules/${module.slug}`} className="text-sm text-accent hover:underline">{module.title}</Link>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
    </div>
  );
}
