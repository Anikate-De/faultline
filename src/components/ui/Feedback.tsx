import { Component, type ReactNode } from "react";
import { AlertTriangle, Loader2, SearchX } from "lucide-react";
import { cn } from "@/lib/format";
import { Button } from "./Button";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-raised", className)} />;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted">
      <Loader2 aria-hidden="true" className="size-4 animate-spin" />
      {label}
    </span>
  );
}

export function RouteFallback() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-8" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading page</span>
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-10 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
      <Skeleton className="h-24" />
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="rounded-[16px] border border-dashed border-border bg-surface px-6 py-10 text-center">
      <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-full border border-border bg-raised text-muted">
        {icon ?? <SearchX aria-hidden="true" className="size-5" />}
      </div>
      <h3 className="text-base font-semibold text-text">{title}</h3>
      <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted">{body}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(): void {
    // The route-level boundary is intentionally silent; no telemetry leaves the browser.
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="mx-auto max-w-xl px-4 py-12">
          <div className="rounded-[16px] border border-[var(--tone-danger-border)] bg-[var(--tone-danger-bg)] p-6">
            <div className="mb-2 flex items-center gap-2 text-danger">
              <AlertTriangle aria-hidden="true" className="size-5" />
              <h2 className="text-base font-semibold">This view failed to render</h2>
            </div>
            <p className="text-sm text-muted">
              The rest of Faultline is still available. Reload the page, or go back to a known route.
            </p>
            <div className="mt-4 flex gap-2">
              <Button onClick={() => window.location.reload()}>Reload</Button>
              <Button variant="ghost" onClick={() => window.history.back()}>
                Go back
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
