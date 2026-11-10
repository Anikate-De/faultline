import { useId } from "react";
import * as Switch from "@radix-ui/react-switch";
import { Moon, Sun } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { IconButton } from "./Button";

export function ThemeToggle() {
  const theme = useAppStore((s) => s.theme);
  const toggle = useAppStore((s) => s.toggleTheme);
  return (
    <IconButton label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} onClick={toggle}>
      {theme === "dark" ? <Sun aria-hidden="true" className="size-4" /> : <Moon aria-hidden="true" className="size-4" />}
    </IconButton>
  );
}

export function InterviewModeToggle() {
  const interviewMode = useAppStore((s) => s.interviewMode);
  const setInterviewMode = useAppStore((s) => s.setInterviewMode);
  const id = useId();
  return (
    <div className="flex min-h-11 items-center gap-2 rounded-[10px] border border-border bg-surface px-3">
      <label htmlFor={id} className="whitespace-nowrap text-xs font-medium text-muted">
        Interview mode
      </label>
      <Switch.Root
        id={id}
        checked={interviewMode}
        onCheckedChange={setInterviewMode}
        className="interview-switch relative h-6 w-11 shrink-0 rounded-full border border-border bg-raised transition-colors"
      >
        <Switch.Thumb className="interview-switch-thumb block size-4 rounded-full shadow-sm" />
      </Switch.Root>
    </div>
  );
}
