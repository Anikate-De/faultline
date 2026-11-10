import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import {
  BarChart3,
  BookOpen,
  FileWarning,
  History,
  Info,
  LayoutGrid,
  ListTree,
  Search,
  ShieldCheck,
} from "lucide-react";
import { TRACKS } from "@/content/tracks";
import { useAppStore } from "@/lib/store";
import { cn, pluralize } from "@/lib/format";
import { ThemeToggle, InterviewModeToggle } from "@/components/ui/ThemeToggle";
const SearchPalette = lazy(() =>
  import("./SearchPalette").then((module) => ({ default: module.SearchPalette })),
);

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <NavLink to="/" className="flex items-center gap-2.5 rounded-md">
      <span className="relative flex size-8 items-center justify-center overflow-hidden rounded-[8px] border border-accent/40 bg-accent/10">
        <span className="font-mono text-sm font-bold text-accent">F</span>
        <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-px rotate-[-18deg] bg-accent/60" />
      </span>
      {compact ? null : (
        <span>
          <span className="block text-sm font-semibold tracking-tight text-text">Faultline</span>
          <span className="block font-mono text-[9px] uppercase tracking-[0.14em] text-faint">Field lab</span>
        </span>
      )}
    </NavLink>
  );
}

function NavItem({
  to,
  icon,
  label,
  end,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex min-h-10 items-center gap-2.5 rounded-[8px] px-2.5 text-sm",
          isActive ? "bg-raised text-text" : "text-muted hover:bg-raised hover:text-text",
        )
      }
    >
      <span className="text-faint">{icon}</span>
      {label}
    </NavLink>
  );
}

function useTrackCompletion(): Record<string, { done: number; total: number }> {
  const completed = useAppStore((s) => s.completed);
  const completedIds = Object.keys(completed);
  const result: Record<string, { done: number; total: number }> = {};
  for (const track of TRACKS) {
    const prefix = track.id === "case-files" ? "case-" : `${track.id}-`;
    result[track.id] = {
      done: completedIds.filter((id) => id.startsWith(prefix)).length,
      total: track.planned,
    };
  }
  return result;
}

export function AppShell({ children }: { children: ReactNode }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const completion = useTrackCompletion();
  const totalDone = Object.values(completion).reduce((sum, item) => sum + item.done, 0);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="min-h-dvh bg-bg text-text">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r border-border bg-surface lg:flex">
        <div className="flex h-14 items-center border-b border-border px-4">
          <Brand />
        </div>
        <nav aria-label="Primary" className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
          <p className="px-2.5 pb-1 font-mono text-[9px] uppercase tracking-[0.14em] text-faint">Learn</p>
          <NavItem to="/" label="Home" icon={<LayoutGrid aria-hidden="true" className="size-4" />} end />
          <NavItem to="/tracks" label="All tracks" icon={<BookOpen aria-hidden="true" className="size-4" />} />
          <NavItem to="/curriculum" label="All modules" icon={<ListTree aria-hidden="true" className="size-4" />} />
          <NavItem to="/case-files" label="Case files" icon={<FileWarning aria-hidden="true" className="size-4" />} />
          <p className="px-2.5 pb-1 pt-4 font-mono text-[9px] uppercase tracking-[0.14em] text-faint">Tracks</p>
          {TRACKS.filter((track) => track.id !== "case-files" && track.id !== "kubernetes")
            .slice(0, 7)
            .map((track) => {
              const item = completion[track.id];
              return (
                <NavLink
                  key={track.id}
                  to={`/tracks/${track.id}`}
                  className={({ isActive }) =>
                    cn(
                      "flex min-h-9 items-center justify-between gap-2 rounded-[8px] px-2.5 text-xs",
                      isActive ? "bg-raised text-text" : "text-muted hover:bg-raised hover:text-text",
                    )
                  }
                >
                  <span className="truncate">{track.short}</span>
                  <span className="font-mono text-[9px] text-faint">
                    {item.done}/{item.total}
                  </span>
                </NavLink>
              );
            })}
          <NavLink to="/tracks" className="flex min-h-9 items-center rounded-[8px] px-2.5 text-xs text-accent hover:bg-raised">
            All {TRACKS.length} tracks
          </NavLink>
          <p className="px-2.5 pb-1 pt-4 font-mono text-[9px] uppercase tracking-[0.14em] text-faint">Practice</p>
          <NavItem to="/review" label="Review" icon={<History aria-hidden="true" className="size-4" />} />
          <NavItem to="/glossary" label="Glossary" icon={<ShieldCheck aria-hidden="true" className="size-4" />} />
          <p className="px-2.5 pb-1 pt-4 font-mono text-[9px] uppercase tracking-[0.14em] text-faint">You</p>
          <NavItem to="/progress" label="Progress" icon={<BarChart3 aria-hidden="true" className="size-4" />} />
          <NavItem to="/about" label="About" icon={<Info aria-hidden="true" className="size-4" />} />
        </nav>
        <div className="border-t border-border px-4 py-3">
          <p className="font-mono text-[10px] text-faint">{pluralize(totalDone, "module")} completed</p>
          <p className="mt-1 text-[10px] leading-snug text-faint">An interactive SRE and DevOps field lab.</p>
        </div>
      </aside>

      <header className="fixed inset-x-0 top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-bg/90 px-3 backdrop-blur lg:left-[248px] lg:px-6">
        <div className="lg:hidden">
          <Brand compact />
        </div>
        <span className="hidden font-mono text-[10px] uppercase tracking-[0.14em] text-faint lg:block">
          An interactive SRE and DevOps field lab
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="flex min-h-11 min-w-11 items-center gap-2 rounded-[10px] border border-border bg-surface px-3 text-xs text-muted hover:text-text"
          >
            <Search aria-hidden="true" className="size-4" />
            <span className="sr-only">Search modules</span>
            <span aria-hidden="true" className="hidden sm:inline">Search</span>
            <kbd className="hidden rounded border border-border bg-raised px-1.5 py-0.5 font-mono text-[9px] text-faint sm:inline">
              ⌘K
            </kbd>
          </button>
          <div>
            <InterviewModeToggle />
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main id="main" className="mx-auto min-h-dvh max-w-[1400px] px-4 pb-28 pt-20 sm:px-6 lg:pl-[280px] lg:pr-8 lg:pt-24">
        {children}
      </main>

      <nav
        aria-label="Mobile navigation"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 backdrop-blur lg:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="grid h-16 grid-cols-4">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              cn("flex flex-col items-center justify-center gap-0.5 text-[10px]", isActive ? "text-accent" : "text-muted")
            }
          >
            <LayoutGrid aria-hidden="true" className="size-5" />
            Learn
          </NavLink>
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="flex flex-col items-center justify-center gap-0.5 text-[10px] text-muted"
          >
            <Search aria-hidden="true" className="size-5" />
            Search
          </button>
          <NavLink
            to="/review"
            className={({ isActive }) =>
              cn("flex flex-col items-center justify-center gap-0.5 text-[10px]", isActive ? "text-accent" : "text-muted")
            }
          >
            <History aria-hidden="true" className="size-5" />
            Review
          </NavLink>
          <NavLink
            to="/progress"
            className={({ isActive }) =>
              cn("flex flex-col items-center justify-center gap-0.5 text-[10px]", isActive ? "text-accent" : "text-muted")
            }
          >
            <BarChart3 aria-hidden="true" className="size-5" />
            Progress
          </NavLink>
        </div>
      </nav>

      {searchOpen ? (
        <Suspense fallback={<div className="fixed inset-0 z-[65] bg-[var(--overlay)]" aria-hidden="true" />}>
          <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}
