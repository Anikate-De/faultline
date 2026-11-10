import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { daysFromNow } from "./format";

export type Theme = "dark" | "light";

export interface ReviewItem {
  moduleId: string;
  due: string;
  interval: number;
  last: string;
  confidence: number;
}

interface ProgressData {
  completed: Record<string, string>;
  confidence: Record<string, number>;
  bookmarks: string[];
  reviews: Record<string, ReviewItem>;
  lastModule: string | null;
  recentSearches: string[];
}

interface AppState extends ProgressData {
  theme: Theme;
  interviewMode: boolean;
  hydrated: boolean;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setInterviewMode: (value: boolean) => void;
  markComplete: (moduleId: string) => void;
  unmarkComplete: (moduleId: string) => void;
  setConfidence: (moduleId: string, rating: number) => void;
  toggleBookmark: (moduleId: string) => void;
  markVisited: (moduleId: string) => void;
  recordSearch: (query: string) => void;
  resetProgress: () => void;
  exportProgress: () => string;
  importProgress: (json: string) => string | null;
}

const emptyProgress: ProgressData = {
  completed: {},
  confidence: {},
  bookmarks: [],
  reviews: {},
  lastModule: null,
  recentSearches: [],
};

const INTERVALS = [1, 3, 7, 21];

function intervalFor(rating: number): number {
  if (rating <= 2) return INTERVALS[0];
  if (rating === 3) return INTERVALS[1];
  if (rating === 4) return INTERVALS[2];
  return INTERVALS[3];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      ...emptyProgress,
      theme: "dark",
      interviewMode: false,
      hydrated: false,
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((s) => ({ theme: s.theme === "dark" ? "light" : "dark" })),
      setInterviewMode: (value) => set({ interviewMode: value }),
      markComplete: (moduleId) =>
        set((s) => ({
          completed: { ...s.completed, [moduleId]: new Date().toISOString() },
        })),
      unmarkComplete: (moduleId) =>
        set((s) => {
          const completed = { ...s.completed };
          delete completed[moduleId];
          return { completed };
        }),
      setConfidence: (moduleId, rating) => {
        const safe = Math.min(5, Math.max(1, Math.round(rating)));
        const interval = intervalFor(safe);
        set((s) => ({
          confidence: { ...s.confidence, [moduleId]: safe },
          reviews: {
            ...s.reviews,
            [moduleId]: {
              moduleId,
              due: daysFromNow(interval),
              interval,
              last: new Date().toISOString(),
              confidence: safe,
            },
          },
        }));
      },
      toggleBookmark: (moduleId) =>
        set((s) => ({
          bookmarks: s.bookmarks.includes(moduleId)
            ? s.bookmarks.filter((id) => id !== moduleId)
            : [...s.bookmarks, moduleId],
        })),
      markVisited: (moduleId) => set({ lastModule: moduleId }),
      recordSearch: (query) =>
        set((s) => ({
          recentSearches: [query, ...s.recentSearches.filter((q) => q !== query)].slice(0, 6),
        })),
      resetProgress: () => set({ ...emptyProgress }),
      exportProgress: () => {
        const s = get();
        return JSON.stringify(
          {
            version: 1,
            exportedAt: new Date().toISOString(),
            completed: s.completed,
            confidence: s.confidence,
            bookmarks: s.bookmarks,
            reviews: s.reviews,
            lastModule: s.lastModule,
          },
          null,
          2,
        );
      },
      importProgress: (json) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch {
          return "That file is not valid JSON.";
        }
        if (!isRecord(parsed)) return "That file does not contain a progress object.";
        if (parsed.version !== undefined && parsed.version !== 1) return "Unsupported progress version.";
        const completed: Record<string, string> = {};
        if (isRecord(parsed.completed)) {
          for (const [key, value] of Object.entries(parsed.completed)) {
            if (validDate(value)) completed[key] = value;
          }
        }
        const confidence: Record<string, number> = {};
        if (isRecord(parsed.confidence)) {
          for (const [key, value] of Object.entries(parsed.confidence)) {
            if (typeof value === "number" && value >= 1 && value <= 5) {
              confidence[key] = Math.round(value);
            }
          }
        }
        const bookmarks = Array.isArray(parsed.bookmarks)
          ? parsed.bookmarks.filter((b): b is string => typeof b === "string").slice(0, 500)
          : [];
        const reviews: Record<string, ReviewItem> = {};
        if (isRecord(parsed.reviews)) {
          for (const [key, value] of Object.entries(parsed.reviews)) {
            if (
              isRecord(value) &&
              validDate(value.due) &&
              validDate(value.last) &&
              typeof value.interval === "number" &&
              typeof value.confidence === "number"
            ) {
              reviews[key] = {
                moduleId: key,
                due: value.due,
                last: value.last,
                interval: value.interval,
                confidence: Math.min(5, Math.max(1, Math.round(value.confidence))),
              };
            }
          }
        }
        set({
          completed,
          confidence,
          bookmarks,
          reviews,
          lastModule: typeof parsed.lastModule === "string" ? parsed.lastModule : null,
        });
        return null;
      },
    }),
    {
      name: "faultline:v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        theme: s.theme,
        interviewMode: s.interviewMode,
        completed: s.completed,
        confidence: s.confidence,
        bookmarks: s.bookmarks,
        reviews: s.reviews,
        lastModule: s.lastModule,
        recentSearches: s.recentSearches,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) state.hydrated = true;
      },
    },
  ),
);

export function dueReviews(now = new Date()): ReviewItem[] {
  const reviews = useAppStore.getState().reviews;
  return Object.values(reviews)
    .filter((item) => new Date(item.due).getTime() <= now.getTime())
    .sort((a, b) => new Date(a.due).getTime() - new Date(b.due).getTime());
}

export function confidenceLabel(rating: number): string {
  return ["Not rated", "Shaky", "Developing", "Solid", "Strong", "Interview-ready"][rating] ?? "Not rated";
}
