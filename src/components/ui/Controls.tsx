import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Minus, Plus, X } from "lucide-react";
import { cn } from "@/lib/format";
import { IconButton } from "./Button";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function Input({ label, hint, error, id, className, ...props }: InputProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const describedBy = [hint ? `${inputId}-hint` : "", error ? `${inputId}-error` : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-sm font-medium text-text">
        {label}
      </label>
      <input
        id={inputId}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy || undefined}
        className={cn(
          "min-h-11 w-full rounded-[10px] border border-border bg-surface px-3 text-sm text-text placeholder:text-faint",
          error && "border-danger",
          className,
        )}
        {...props}
      />
      {hint ? (
        <p id={`${inputId}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${inputId}-error`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface NumberInputProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
  id?: string;
  help?: string;
}

export function NumberInput({ label, value, min, max, step, unit, onChange, id, help }: NumberInputProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const stepTo = (delta: number) =>
    onChange(Math.min(max, Math.max(min, Number((value + delta).toFixed(4)))));
  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-sm font-medium text-text">
        {label}
      </label>
      <div className="flex items-stretch gap-1.5">
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          onClick={() => stepTo(-step)}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-[10px] border border-border bg-raised text-muted hover:text-text"
        >
          <Minus aria-hidden="true" className="size-4" />
        </button>
        <div className="relative flex-1">
          <input
            id={inputId}
            type="number"
            inputMode="decimal"
            value={value}
            min={min}
            max={max}
            step={step}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
            }}
            aria-describedby={help ? `${inputId}-help` : undefined}
            className="min-h-11 w-full rounded-[10px] border border-border bg-surface px-3 pr-10 font-mono text-sm tabular-nums text-text"
          />
          {unit ? (
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center font-mono text-xs text-faint">
              {unit}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          aria-label={`Increase ${label}`}
          onClick={() => stepTo(step)}
          className="flex min-h-11 min-w-11 items-center justify-center rounded-[10px] border border-border bg-raised text-muted hover:text-text"
        >
          <Plus aria-hidden="true" className="size-4" />
        </button>
      </div>
      {help ? (
        <p id={`${inputId}-help`} className="text-xs text-muted">
          {help}
        </p>
      ) : null}
    </div>
  );
}

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  title?: string;
}

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <span className="block text-sm font-medium text-text">{label}</span>
      <div role="group" aria-label={label} className="flex flex-wrap gap-1 rounded-[10px] border border-border bg-surface p-1">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={cn(
              "min-h-11 flex-1 rounded-md px-2.5 text-xs font-medium transition-colors",
              value === option.value
                ? "bg-accent text-[color:var(--accent-contrast)]"
                : "text-muted hover:bg-raised hover:text-text",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface TabItem {
  id: string;
  label: string;
  content: ReactNode;
}

export function Tabs({ items, label, initialId }: { items: TabItem[]; label: string; initialId?: string }) {
  const [active, setActive] = useState(initialId ?? items[0]?.id);
  const id = useId();
  const current = items.find((item) => item.id === active) ?? items[0];
  return (
    <div>
      <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-border pb-px">
        {items.map((item) => (
          <button
            key={item.id}
            id={`${id}-tab-${item.id}`}
            role="tab"
            type="button"
            aria-selected={current?.id === item.id}
            aria-controls={`${id}-panel-${item.id}`}
            tabIndex={current?.id === item.id ? 0 : -1}
            onClick={() => setActive(item.id)}
            onKeyDown={(event) => {
              const index = items.findIndex((i) => i.id === item.id);
              if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                event.preventDefault();
                const delta = event.key === "ArrowRight" ? 1 : -1;
                const next = items[(index + delta + items.length) % items.length];
                setActive(next.id);
                document.getElementById(`${id}-tab-${next.id}`)?.focus();
              }
            }}
            className={cn(
              "min-h-11 shrink-0 rounded-t-md px-3 text-sm font-medium",
              current?.id === item.id
                ? "border-b-2 border-accent text-text"
                : "border-b-2 border-transparent text-muted hover:text-text",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      {current ? (
        <div
          key={current.id}
          id={`${id}-panel-${current.id}`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${current.id}`}
          className="pt-4"
        >
          {current.content}
        </div>
      ) : null}
    </div>
  );
}

export function Accordion({
  items,
  label,
}: {
  items: { id: string; title: string; content: ReactNode; defaultOpen?: boolean }[];
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="divide-y divide-border overflow-hidden rounded-[12px] border border-border bg-surface">
      {items.map((item) => (
        <details key={item.id} open={item.defaultOpen} className="group">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-text">
            {item.title}
            <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" />
          </summary>
          <div className="px-4 pb-4 text-sm leading-relaxed text-muted">{item.content}</div>
        </details>
      ))}
    </div>
  );
}

function useFocusTrap(open: boolean, panelRef: React.RefObject<HTMLDivElement | null>, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusable = () =>
      panel
        ? Array.from(
            panel.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((el) => el.offsetParent !== null)
        : [];
    const first = focusable()[0];
    (first ?? panel)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "Tab") {
        const nodes = focusable();
        if (nodes.length === 0) return;
        const firstNode = nodes[0];
        const lastNode = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === firstNode) {
          event.preventDefault();
          lastNode.focus();
        } else if (!event.shiftKey && document.activeElement === lastNode) {
          event.preventDefault();
          firstNode.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      previous?.focus?.();
    };
  }, [open, panelRef, onClose]);
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  variant = "center",
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  variant?: "center" | "bottom" | "full";
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  useFocusTrap(open, panelRef, onClose);
  if (!open) return null;
  const position =
    variant === "full"
      ? "inset-0 rounded-none border-0"
      : variant === "bottom"
        ? "inset-x-0 bottom-0 max-h-[88vh] rounded-t-[20px] border-x-0 border-b-0"
        : "inset-x-3 top-[8vh] max-h-[84vh] rounded-[20px] sm:inset-x-auto sm:left-1/2 sm:w-[min(560px,92vw)] sm:-translate-x-1/2";
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center sm:items-start"
      style={{ background: "var(--overlay)" }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          "relative flex w-full flex-col border border-border bg-surface shadow-2xl",
          position,
          className,
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-text">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-1 text-sm text-muted">
                {description}
              </p>
            ) : null}
          </div>
          <IconButton label="Close dialog" onClick={onClose}>
            <X aria-hidden="true" className="size-5" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="border-t border-border px-5 py-3">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export function Sheet(props: Omit<Parameters<typeof Dialog>[0], "variant">) {
  return <Dialog {...props} variant="bottom" />;
}

interface ToastItem {
  id: number;
  message: string;
  tone: "info" | "success" | "danger";
}

const ToastContext = createContext<{ toast: (message: string, tone?: ToastItem["tone"]) => void } | null>(
  null,
);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const toast = useCallback((message: string, tone: ToastItem["tone"] = "info") => {
    const id = ++counter.current;
    setItems((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id));
    }, 3200);
  }, []);
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div aria-live="polite" className="fixed inset-x-3 bottom-20 z-[70] flex flex-col items-center gap-2 sm:bottom-6">
          {items.map((item) => (
            <div
              key={item.id}
              role="status"
              className={cn(
                "w-full max-w-md rounded-[10px] border px-4 py-3 text-sm shadow-lg",
                item.tone === "success"
                  ? "border-[var(--tone-success-border)] bg-[var(--tone-success-bg)] text-success"
                  : item.tone === "danger"
                    ? "border-[var(--tone-danger-border)] bg-[var(--tone-danger-bg)] text-danger"
                    : "border-border bg-raised text-text",
              )}
            >
              {item.message}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- provider and hook share one context
export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider");
  return context;
}
