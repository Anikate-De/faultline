import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Download, RotateCcw, Upload, ShieldCheck } from "lucide-react";
import { MANIFEST, MODULE_BY_ID } from "@/content/manifest";
import { TRACKS } from "@/content/tracks";
import { confidenceLabel, dueReviews, useAppStore } from "@/lib/store";
import { formatDate, pluralize } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog, useToast } from "@/components/ui/Controls";
import { EmptyState } from "@/components/ui/Feedback";
import { ProgressRing } from "@/components/ui/Progress";
import { OfflinePanel } from "@/components/ui/OfflinePanel";

export default function Progress() {
  const completed = useAppStore((s) => s.completed);
  const confidence = useAppStore((s) => s.confidence);
  const bookmarks = useAppStore((s) => s.bookmarks);
  const reviews = useAppStore((s) => s.reviews);
  const exportProgress = useAppStore((s) => s.exportProgress);
  const importProgress = useAppStore((s) => s.importProgress);
  const resetProgress = useAppStore((s) => s.resetProgress);
  const unmarkComplete = useAppStore((s) => s.unmarkComplete);
  const { toast } = useToast();
  const [resetOpen, setResetOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const due = dueReviews();
  const completedCount = Object.keys(completed).length;
  const percent = MANIFEST.length ? Math.round((completedCount / MANIFEST.length) * 100) : 0;
  const confidenceCounts = [1, 2, 3, 4, 5].map((rating) => ({
    rating,
    count: Object.values(confidence).filter((value) => value === rating).length,
  }));
  const maxConfidence = Math.max(1, ...confidenceCounts.map((item) => item.count));

  function download() {
    const blob = new Blob([exportProgress()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `faultline-progress-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast("Progress exported.", "success");
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    const error = importProgress(text);
    if (error) toast(error, "danger");
    else toast("Progress imported.", "success");
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="space-y-6">
      <header className="max-w-3xl">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent">Local only</p>
        <h1 className="mt-1">Progress</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Completion, confidence, bookmarks, and the review queue live in this browser. Export a JSON file to move
          them. Nothing is sent to a server.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="flex items-center gap-4 rounded-[16px] border border-border bg-surface p-4">
          <ProgressRing value={percent} size={56} />
          <div>
            <p className="font-mono text-xl text-text">{completedCount}</p>
            <p className="text-xs text-muted">modules completed</p>
            <p className="text-[10px] text-faint">of {MANIFEST.length} planned</p>
          </div>
        </div>
        <div className="rounded-[16px] border border-border bg-surface p-4">
          <p className="font-mono text-xl text-text">{Object.keys(confidence).length}</p>
          <p className="text-xs text-muted">confidence ratings</p>
          <p className="text-[10px] text-faint">scheduled at 1 / 3 / 7 / 21 days</p>
        </div>
        <div className="rounded-[16px] border border-border bg-surface p-4">
          <p className="font-mono text-xl text-text">{bookmarks.length}</p>
          <p className="text-xs text-muted">bookmarks</p>
          <p className="text-[10px] text-faint">saved in this browser</p>
        </div>
        <div className="rounded-[16px] border border-border bg-surface p-4">
          <p className="font-mono text-xl text-text">{due.length}</p>
          <p className="text-xs text-muted">reviews due</p>
          <Link to="/review" className="text-[10px] text-accent hover:underline">Open review</Link>
        </div>
      </section>

      <section className="rounded-[16px] border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">Confidence distribution</h2>
        {Object.keys(confidence).length ? (
          <div className="mt-3 space-y-2">
            {confidenceCounts.map((item) => (
              <div key={item.rating} className="flex items-center gap-2">
                <span className="w-24 text-xs text-muted">{confidenceLabel(item.rating)}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-raised">
                  <span className="block h-full rounded-full bg-accent" style={{ width: `${(item.count / maxConfidence) * 100}%` }} />
                </span>
                <span className="w-6 text-right font-mono text-[10px] text-faint">{item.count}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted">No ratings yet. Open a module and rate confidence after the interview drill.</p>
        )}
      </section>

      <section className="rounded-[16px] border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">Track progress</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {TRACKS.filter((track) => track.planned > 0).map((track) => {
            const done = MANIFEST.filter((m) => m.track === track.id && completed[m.id]).length;
            const trackPercent = track.planned ? Math.round((done / track.planned) * 100) : 0;
            return (
              <div key={track.id} className="rounded-md border border-border p-2">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <Link to={`/tracks/${track.id}`} className="text-muted hover:text-text">{track.short}</Link>
                  <span className="font-mono text-[10px] text-faint">{done}/{track.planned}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${trackPercent}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-[16px] border border-border bg-surface p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-text">Completed modules</h2>
          <Badge tone="success">{completedCount}</Badge>
        </div>
        {completedCount ? (
          <ul className="mt-3 space-y-1">
            {Object.entries(completed).map(([id, at]) => {
              const module = MODULE_BY_ID.get(id);
              return (
                <li key={id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs">
                  <span className="min-w-0 flex-1 truncate text-muted">{module?.title ?? id}</span>
                  <span className="font-mono text-[10px] text-faint">{formatDate(at)}</span>
                  <Button size="sm" variant="ghost" aria-label={`Undo completion for ${module?.title ?? id}`} onClick={() => unmarkComplete(id)}>
                    Undo
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">No completed modules. Mark one complete and you can undo it here or in the module header.</p>
        )}
      </section>

      <section className="rounded-[16px] border border-border bg-surface p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-text">Bookmarks</h2>
          <Badge>{bookmarks.length}</Badge>
        </div>
        {bookmarks.length ? (
          <ul className="mt-3 space-y-1">
            {bookmarks.map((id) => {
              const module = MODULE_BY_ID.get(id);
              return (
                <li key={id} className="text-sm">
                  {module ? <Link to={`/modules/${module.slug}`} className="text-accent hover:underline">{module.title}</Link> : <span className="text-muted">{id}</span>}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">No bookmarks. Use the bookmark button in a module header.</p>
        )}
      </section>

      <section className="rounded-[16px] border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">Review schedule</h2>
        {Object.keys(reviews).length ? (
          <ul className="mt-3 space-y-1">
            {Object.values(reviews).sort((a, b) => new Date(a.due).getTime() - new Date(b.due).getTime()).slice(0, 12).map((item) => {
              const module = MODULE_BY_ID.get(item.moduleId);
              return (
                <li key={item.moduleId} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate text-muted">{module?.title ?? item.moduleId}</span>
                  <span className="font-mono text-faint">{confidenceLabel(item.confidence)}</span>
                  <span className="font-mono text-faint">due {formatDate(item.due)}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">No scheduled reviews. Rate confidence after a module.</p>
        )}
      </section>

      <section className="rounded-[16px] border border-border bg-surface p-5">
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck aria-hidden="true" className="size-4 text-success" />
          <h2 className="text-sm font-semibold text-text">Data controls</h2>
        </div>
        <p className="mt-1 text-xs text-muted">
          Export is a JSON file with progress, confidence, bookmarks, and review dates. Import validates the shape
          before replacing local data.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={download}>
            <Download aria-hidden="true" className="size-4" /> Export JSON
          </Button>
          <Button variant="secondary" onClick={() => fileRef.current?.click()}>
            <Upload aria-hidden="true" className="size-4" /> Import JSON
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label="Import progress JSON"
            onChange={(event) => void upload(event.target.files?.[0])}
          />
          <Button variant="danger" onClick={() => setResetOpen(true)}>
            <RotateCcw aria-hidden="true" className="size-4" /> Reset progress
          </Button>
        </div>
      </section>

      <OfflinePanel />

      {completedCount === 0 ? (
        <EmptyState
          title="No progress yet"
          body="Complete a module or rate confidence to start building a review history. The export file is useful before you reset or switch browsers."
          action={<Link to="/" className="text-sm text-accent hover:underline">Start with a module</Link>}
        />
      ) : null}

      <Dialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset local progress?"
        description="This removes completion, confidence, bookmarks, and review dates from this browser. Theme and interview mode stay."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setResetOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                resetProgress();
                setResetOpen(false);
                toast("Local progress reset.", "success");
              }}
            >
              Reset progress
            </Button>
          </div>
        }
      >
        <p className="text-sm text-muted">
          Export first if you want a copy. This action cannot be undone. {pluralize(completedCount, "completed module")} will be cleared.
        </p>
      </Dialog>
    </div>
  );
}
