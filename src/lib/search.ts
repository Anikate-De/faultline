import { useEffect, useState } from "react";
import type { TrackId } from "@/content/types";

export interface SearchEntry {
  id: string;
  slug: string;
  title: string;
  track: TrackId;
  tags: string[];
  productionQuestion: string;
  learningDelta: string;
  objectives: string[];
  minutes: number;
  difficulty: number;
}

interface SearchIndexFile {
  version: number;
  entries: SearchEntry[];
}

let cache: SearchEntry[] | null = null;
let pending: Promise<SearchEntry[]> | null = null;

export async function loadSearchIndex(): Promise<SearchEntry[]> {
  if (cache) return cache;
  if (!pending) {
    pending = import("@/generated/search-index.json").then((mod) => {
      const data = mod.default as SearchIndexFile;
      cache = data.entries ?? [];
      return cache;
    });
  }
  return pending;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function scoreEntry(entry: SearchEntry, query: string): number {
  const q = normalize(query);
  if (!q) return 0;
  const terms = q.split(" ").filter(Boolean);
  const title = normalize(entry.title);
  const tags = normalize(entry.tags.join(" "));
  const delta = normalize(entry.learningDelta);
  const question = normalize(entry.productionQuestion);
  const objectives = normalize(entry.objectives.join(" "));
  let score = 0;
  for (const term of terms) {
    if (title.startsWith(term)) score += 40;
    else if (title.includes(term)) score += 24;
    if (tags.includes(term)) score += 16;
    if (delta.includes(term)) score += 12;
    if (question.includes(term)) score += 8;
    if (objectives.includes(term)) score += 4;
  }
  if (title.includes(q)) score += 30;
  return score;
}

export function searchEntries(entries: SearchEntry[], query: string, limit = 12): SearchEntry[] {
  if (!normalize(query)) return [];
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title))
    .slice(0, limit)
    .map((item) => item.entry);
}

export function useSearchIndex(active: boolean) {
  const [entries, setEntries] = useState<SearchEntry[]>(cache ?? []);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active || cache) return;
    let cancelled = false;
    loadSearchIndex()
      .then((next) => {
        if (!cancelled) setEntries(next);
      })
      .catch(() => {
        if (!cancelled) setError("Search index unavailable.");
      });
    return () => {
      cancelled = true;
    };
  }, [active]);
  return { entries, error, loading: active && !cache && !error };
}
