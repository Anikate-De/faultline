import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-file-descriptors",
  slug: "file-descriptors",
  title: "File Descriptors: The Invisible Capacity Limit",
  track: "foundations",
  order: 21,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["foundations-linux-memory"],
  tags: ["file descriptor", "ulimit", "socket leak", "epoll", "lsof"],
  productionQuestion:
    "The service is healthy but new connections fail with “too many open files”; where do you look?",
  learningDelta:
    "Every socket and file consumes an fd; per-process and system limits turn leaks into hard failures",
  objectives: [
    "Explain how sockets, files, and epoll registrations consume file descriptors.",
    "Distinguish a descriptor leak from a traffic spike using the fd count and its slope.",
    "Choose between fixing the close path and raising the limit, and state the tradeoff.",
    "Read the signals that separate fd exhaustion from CPU or memory saturation.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
