import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { ArrowRight, Clock3, Search, X } from "lucide-react";
import { searchEntries, useSearchIndex } from "@/lib/search";
import { TRACK_BY_ID } from "@/content/tracks";
import { useAppStore } from "@/lib/store";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Feedback";

export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const inputId = useId();
  const { entries, error, loading } = useSearchIndex(open);
  const recent = useAppStore((s) => s.recentSearches);
  const recordSearch = useAppStore((s) => s.recordSearch);
  const results = searchEntries(entries, query);

  function choose(slug: string) {
    if (query.trim()) recordSearch(query.trim());
    navigate(`/modules/${slug}`);
    onClose();
  }

  if (!open) return null;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[65] bg-[var(--overlay)]" />
        <Dialog.Content className="fixed inset-0 z-[66] flex flex-col border border-border bg-surface shadow-2xl outline-none sm:inset-auto sm:left-1/2 sm:top-24 sm:max-h-[72vh] sm:w-[min(680px,92vw)] sm:-translate-x-1/2 sm:rounded-[16px]">
          <Dialog.Title className="sr-only">Search Faultline</Dialog.Title>
          <Dialog.Description className="sr-only">
            Search authored modules by title, track, tags, production question, or learning delta.
          </Dialog.Description>
          <Command shouldFilter={false} loop className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 focus-within:border-accent">
              <Search aria-hidden="true" className="size-5 shrink-0 text-faint" />
              <label htmlFor={inputId} className="sr-only">
                Search modules and tracks
              </label>
              <Command.Input
                id={inputId}
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder="Search modules, concepts, and tracks"
                style={{ outline: "none" }}
                className="min-h-12 flex-1 bg-transparent text-base text-text placeholder:text-faint"
              />
              <Dialog.Close
                aria-label="Close search"
                className="flex size-11 shrink-0 items-center justify-center rounded-[10px] text-muted hover:bg-raised hover:text-text"
              >
                <X aria-hidden="true" className="size-5" />
              </Dialog.Close>
            </div>

            <Command.List className="min-h-0 flex-1 overflow-y-auto p-2">
              {loading ? (
                <div className="space-y-2 p-2" aria-hidden="true">
                  <Skeleton className="h-12" />
                  <Skeleton className="h-12" />
                  <Skeleton className="h-12" />
                </div>
              ) : null}
              {error ? <p className="p-3 text-sm text-danger">{error}</p> : null}

              {!query ? (
                <>
                  {recent.length ? (
                    <Command.Group heading="Recent searches" className="px-1 py-2 text-xs text-faint">
                      <div className="flex flex-wrap gap-1.5 px-2 pb-2 pt-1">
                        {recent.map((item) => (
                          <Command.Item
                            key={item}
                            value={`recent-${item}`}
                            onSelect={() => setQuery(item)}
                            className="cursor-pointer rounded-full border border-border bg-raised px-3 py-1.5 text-xs text-muted data-[selected=true]:border-accent data-[selected=true]:text-text"
                          >
                            {item}
                          </Command.Item>
                        ))}
                      </div>
                    </Command.Group>
                  ) : null}
                  <Command.Group heading="Try" className="px-1 py-2 text-xs text-faint">
                    <div className="flex flex-wrap gap-1.5 px-2 pb-2 pt-1">
                      {["hot key", "retry storm", "canary", "replication lag"].map((item) => (
                        <Command.Item
                          key={item}
                          value={`suggestion-${item}`}
                          onSelect={() => setQuery(item)}
                          className="cursor-pointer rounded-full border border-border bg-raised px-3 py-1.5 text-xs text-muted data-[selected=true]:border-accent data-[selected=true]:text-text"
                        >
                          {item}
                        </Command.Item>
                      ))}
                    </div>
                  </Command.Group>
                  {entries.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted">
                      Authored modules will appear here as they are built. Start with the demo in the Caching track.
                    </p>
                  ) : null}
                </>
              ) : null}

              {query ? (
                <>
                  <Command.Empty className="p-4 text-sm text-muted">
                    No authored module matches “{query}”. Planned modules do not appear in search until they are authored.
                  </Command.Empty>
                  <Command.Group heading="Modules" className="text-xs text-faint">
                    {results.map((entry) => {
                      const track = TRACK_BY_ID.get(entry.track);
                      return (
                        <Command.Item
                          key={entry.id}
                          value={`${entry.title} ${entry.track}`}
                          onSelect={() => choose(entry.slug)}
                          className="flex cursor-pointer items-start gap-3 rounded-[10px] px-3 py-2.5 text-left data-[selected=true]:bg-raised"
                        >
                          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface font-mono text-[10px] text-accent">
                            {String(entry.difficulty).padStart(2, "0")}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-medium text-text">{entry.title}</span>
                              <Badge>{track?.short ?? entry.track}</Badge>
                            </span>
                            <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{entry.productionQuestion}</span>
                          </span>
                          <span className="hidden shrink-0 items-center gap-1 font-mono text-[10px] text-faint sm:flex">
                            <Clock3 aria-hidden="true" className="size-3" />
                            {entry.minutes}m
                          </span>
                          <ArrowRight aria-hidden="true" className="mt-1 size-4 shrink-0 text-faint" />
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                </>
              ) : null}
            </Command.List>
          </Command>

          <div className="hidden items-center gap-3 border-t border-border px-3 py-2 font-mono text-[10px] text-faint sm:flex">
            <span>↑↓ to move</span>
            <span>Enter to open</span>
            <span>Esc to close</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
