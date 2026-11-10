import { useState } from "react";
import { Link } from "react-router-dom";
import { BookMarked, Search } from "lucide-react";
import { GLOSSARY } from "@/content/glossary";
import { TRACK_BY_ID, TRACKS } from "@/content/tracks";
import { Input } from "@/components/ui/Controls";
import { Badge } from "@/components/ui/Badge";

export default function Glossary() {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = GLOSSARY.filter((term) => {
    if (!q) return true;
    return (
      term.term.toLowerCase().includes(q) ||
      term.short.toLowerCase().includes(q) ||
      term.body.toLowerCase().includes(q) ||
      term.aliases?.some((alias) => alias.toLowerCase().includes(q))
    );
  });
  const groups = TRACKS.map((track) => ({
    track,
    terms: filtered.filter((term) => term.track === track.id).sort((a, b) => a.term.localeCompare(b.term)),
  })).filter((group) => group.terms.length > 0);

  return (
    <div className="space-y-6">
      <header className="max-w-3xl">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent">Reference</p>
        <h1 className="mt-1">Glossary</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          The terms that show up in incident channels and interviews. Definitions are short, concrete, and tied to
          the track that teaches the failure mode.
        </p>
      </header>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-96">
          <label htmlFor="glossary-search" className="mb-1 block text-xs font-medium text-muted">
            Search terms
          </label>
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-3.5 size-4 text-faint" />
            <Input
              id="glossary-search"
              label=""
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="hot key, p99, split brain"
              aria-label="Search glossary terms"
              className="pl-9"
            />
          </div>
        </div>
        <p className="text-xs text-faint" role="status">
          {filtered.length} of {GLOSSARY.length} terms
        </p>
      </div>
      {groups.length === 0 ? (
        <div className="rounded-[16px] border border-dashed border-border bg-surface p-8 text-center text-sm text-muted">
          No term matches “{query}”. Try a shorter concept.
        </div>
      ) : (
        <div className="space-y-7">
          {groups.map(({ track, terms }) => (
            <section key={track.id} aria-labelledby={`glossary-${track.id}`}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h2 id={`glossary-${track.id}`} className="text-base font-semibold text-text">
                  {track.title}
                </h2>
                <Badge>{terms.length}</Badge>
                <Link to={`/tracks/${track.id}`} className="ml-auto text-xs text-accent hover:underline">
                  Open track
                </Link>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {terms.map((term) => (
                  <article key={term.id} id={term.id} className="scroll-mt-24 rounded-[12px] border border-border bg-surface p-4">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-semibold text-text">{term.term}</h3>
                      <BookMarked aria-hidden="true" className="size-3.5 shrink-0 text-faint" />
                    </div>
                    <p className="mt-1 text-xs font-medium text-accent">{term.short}</p>
                    <p className="mt-2 text-sm leading-relaxed text-muted">{term.body}</p>
                    {term.aliases?.length ? <p className="mt-2 text-[10px] text-faint">Also: {term.aliases.join(", ")}</p> : null}
                    {term.related?.length ? (
                      <p className="mt-2 text-[10px] text-faint">
                        Related:{" "}
                        {term.related
                          .map((id) => GLOSSARY.find((item) => item.id === id)?.term)
                          .filter(Boolean)
                          .join(", ")}
                      </p>
                    ) : null}
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      <p className="text-xs text-faint">
        Tracks: {TRACKS.filter((track) => track.id !== "kubernetes").map((track) => TRACK_BY_ID.get(track.id)?.short).join(" · ")}
      </p>
    </div>
  );
}
