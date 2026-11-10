import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/format";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "interview";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent text-[color:var(--accent-contrast)] hover:bg-accent-strong border border-transparent",
  secondary: "bg-raised text-text border border-border hover:border-faint",
  ghost: "bg-transparent text-muted border border-transparent hover:bg-raised hover:text-text",
  danger: "bg-[var(--tone-danger-bg)] text-danger border border-[var(--tone-danger-border)]",
  interview: "bg-[var(--tone-interview-bg)] text-[var(--interview)] border border-[var(--tone-interview-border)]",
};

const sizes: Record<Size, string> = {
  sm: "min-h-11 px-3 text-sm gap-1.5",
  md: "min-h-11 px-4 text-sm gap-2",
  lg: "min-h-12 px-5 text-base gap-2",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  className,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex select-none items-center justify-center rounded-[10px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  variant?: Variant;
}

export function IconButton({ label, variant = "ghost", className, children, ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] border border-transparent transition-colors",
        variants[variant],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
