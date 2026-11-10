import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Download, RefreshCcw, WifiOff } from "lucide-react";
import { Badge } from "./Badge";
import { Button } from "./Button";

type OfflineStatus = "checking" | "ready" | "unsupported" | "error" | "dev";

export function OfflinePanel() {
  const [status, setStatus] = useState<OfflineStatus>(import.meta.env.PROD ? "checking" : "dev");
  const [size, setSize] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    if (!("serviceWorker" in navigator)) {
      setStatus("unsupported");
      return;
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      setBusy(true);
      setStatus("checking");
      await registration.update().catch(() => undefined);
      if (!registration.active) {
        setStatus("error");
        return;
      }
      const estimate = await navigator.storage?.estimate?.();
      if (estimate?.usage) setSize(`${(estimate.usage / 1024 / 1024).toFixed(1)} MB`);
      setStatus("ready");
    } catch {
      setStatus("error");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!import.meta.env.PROD) return;
    queueMicrotask(() => {
      void check();
    });
  }, [check]);

  return (
    <section className="rounded-[16px] border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center gap-2">
        <WifiOff aria-hidden="true" className="size-4 text-accent" />
        <h2 className="text-sm font-semibold text-text">Offline</h2>
        {status === "ready" ? <Badge tone="success">Ready</Badge> : null}
        {status === "checking" ? <Badge tone="info">Checking</Badge> : null}
        {status === "unsupported" ? <Badge tone="warn">Unavailable</Badge> : null}
        {status === "error" ? <Badge tone="danger">Failed</Badge> : null}
        {status === "dev" ? <Badge tone="info">Production only</Badge> : null}
        {size ? <span className="ml-auto font-mono text-[10px] text-faint">cached {size}</span> : null}
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted" role="status" aria-live="polite">
        {status === "ready"
          ? "The app shell, authored modules, fonts, and simulation code are cached on this device. Open Faultline once while online before a flight, then use the installed app or this browser without a connection."
          : status === "checking"
            ? "Checking the local cache and preparing the offline copy."
            : status === "dev"
              ? "Offline saving is enabled in the production build. Run `npm run build && npm run preview` to test it."
              : status === "unsupported"
                ? "This browser does not expose a service worker, so the app cannot cache itself for offline use."
                : "The offline cache could not be prepared. Check that you are on the production build and reload the page."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={() => void check()} disabled={busy || status === "unsupported" || status === "dev"}>
          {status === "ready" ? <RefreshCcw aria-hidden="true" className="size-4" /> : <Download aria-hidden="true" className="size-4" />}
          {status === "ready" ? "Refresh offline copy" : "Save for offline"}
        </Button>
        {status === "ready" ? (
          <span className="inline-flex items-center gap-1 text-xs text-success">
            <CheckCircle2 aria-hidden="true" className="size-4" /> Available offline
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-[10px] leading-snug text-faint">
        Progress, confidence, bookmarks, and review dates remain in local storage. The cache is separate and can be refreshed without deleting progress.
      </p>
    </section>
  );
}
