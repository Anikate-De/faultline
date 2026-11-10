import { beforeEach, describe, expect, it } from "vitest";
import { searchEntries, scoreEntry, type SearchEntry } from "@/lib/search";
import { useAppStore } from "@/lib/store";

const entries: SearchEntry[] = [
  {
    id: "caching-hot-key-sharding",
    slug: "hot-key-sharding",
    title: "Hot Key Sharding",
    track: "caching",
    tags: ["Redis", "hot key"],
    productionQuestion: "One key saturates one shard. What do you do?",
    learningDelta: "A hot key is a partitioning problem.",
    objectives: ["Diagnose a hot shard."],
    minutes: 20,
    difficulty: 3,
  },
  {
    id: "foundations-retry",
    slug: "retry-backoff-jitter",
    title: "Retries, Backoff, and Jitter",
    track: "foundations",
    tags: ["retry", "backoff"],
    productionQuestion: "Why did traffic triple during a two-second failure?",
    learningDelta: "Synchronized retries amplify failure.",
    objectives: ["Design a retry budget."],
    minutes: 18,
    difficulty: 2,
  },
];

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ completed: {}, confidence: {}, bookmarks: [], reviews: {}, lastModule: null, recentSearches: [] });
});

describe("search", () => {
  it("ranks title matches above objective matches", () => {
    expect(scoreEntry(entries[0], "hot key")).toBeGreaterThan(scoreEntry(entries[0], "diagnose"));
    expect(searchEntries(entries, "hot key")[0].id).toBe(entries[0].id);
  });

  it("returns no results for an empty query", () => {
    expect(searchEntries(entries, "")).toEqual([]);
  });

  it("finds by production question", () => {
    expect(searchEntries(entries, "traffic triple")[0].id).toBe(entries[1].id);
  });
});

describe("progress store", () => {
  it("exports and imports validated progress", () => {
    const state = useAppStore.getState();
    state.markComplete("caching-hot-key-sharding");
    state.setConfidence("caching-hot-key-sharding", 4);
    state.toggleBookmark("caching-hot-key-sharding");
    const exported = useAppStore.getState().exportProgress();
    useAppStore.getState().resetProgress();
    expect(Object.keys(useAppStore.getState().completed)).toHaveLength(0);
    const error = useAppStore.getState().importProgress(exported);
    expect(error).toBeNull();
    expect(useAppStore.getState().completed["caching-hot-key-sharding"]).toBeTruthy();
    expect(useAppStore.getState().confidence["caching-hot-key-sharding"]).toBe(4);
    expect(useAppStore.getState().bookmarks).toContain("caching-hot-key-sharding");
  });

  it("rejects malformed imports", () => {
    expect(useAppStore.getState().importProgress("not json")).toMatch(/valid JSON/);
    expect(useAppStore.getState().importProgress('{"version": 99}')).toMatch(/Unsupported/);
    expect(useAppStore.getState().importProgress('{"completed": {"x": "bad"}}')).toBeNull();
    expect(useAppStore.getState().completed).toEqual({});
  });

  it("can undo a completed module", () => {
    const state = useAppStore.getState();
    state.markComplete("caching-hot-key-sharding");
    expect(useAppStore.getState().completed["caching-hot-key-sharding"]).toBeTruthy();
    useAppStore.getState().unmarkComplete("caching-hot-key-sharding");
    expect(useAppStore.getState().completed["caching-hot-key-sharding"]).toBeUndefined();
  });

  it("maps confidence to spaced intervals", () => {
    const state = useAppStore.getState();
    state.setConfidence("a", 1);
    state.setConfidence("b", 3);
    state.setConfidence("c", 5);
    const reviews = useAppStore.getState().reviews;
    const days = (id: string) => Math.round((new Date(reviews[id].due).getTime() - Date.now()) / 86_400_000);
    expect(days("a")).toBeLessThanOrEqual(2);
    expect(days("b")).toBeGreaterThanOrEqual(2);
    expect(days("c")).toBeGreaterThanOrEqual(20);
  });
});
