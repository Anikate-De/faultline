import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-change-streams",
  slug: "change-streams",
  title: "Change Streams",
  track: "mongodb",
  order: 16,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["mongodb-replication-lag"],
  tags: ["change streams", "resume token", "oplog", "majority", "polling"],
  productionQuestion:
    "A downstream service polls MongoDB every second and adds load. Can it subscribe instead?",
  learningDelta:
    "Change streams expose a resumable oplog cursor; resume tokens and majority read concern determine durability and replay",
  objectives: [
    "Describe how a change stream cursor follows majority-committed changes without polling queries.",
    "Explain the role of the resume token when a consumer reconnects.",
    "Predict what happens when a consumer is down longer than the oplog retains history.",
    "Choose between polling and a change stream for a downstream integration.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
