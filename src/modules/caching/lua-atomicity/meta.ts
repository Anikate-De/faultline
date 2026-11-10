import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-lua-atomicity",
  slug: "lua-atomicity",
  title: "Lua Scripts: Atomicity and Blocking",
  track: "caching",
  order: 23,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["caching-slow-commands"],
  tags: ["Lua", "atomicity", "EVAL", "script timeout", "blocking", "race"],
  productionQuestion:
    "A Lua script fixes a race but raises p99. What is the risk?",
  learningDelta:
    "Lua runs atomically on the server and blocks other commands; long scripts turn correctness fixes into latency incidents",
  objectives: [
    "Explain what Lua atomicity guarantees and what it does not.",
    "Connect script duration and write rate to the shard's event-loop occupancy.",
    "Diagnose a lost-update race and choose between Lua, a single command, and optimistic retry.",
    "Bound a script so a correctness fix does not become a latency incident.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
