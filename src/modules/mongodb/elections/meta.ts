import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-elections",
  slug: "elections",
  title: "Elections and Availability",
  track: "mongodb",
  order: 7,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["mongodb-replica-set"],
  tags: ["election", "majority", "heartbeat", "election timeout", "failover"],
  productionQuestion:
    "The primary failed and writes failed for 12 seconds. What determines that window?",
  learningDelta:
    "Elections require a majority and take time; electionTimeout, heartbeat, and catch-up determine write availability",
  objectives: [
    "Break the write outage into detection, election, catch-up, and client discovery.",
    "Explain why a majority of voting members is required and how member loss changes it.",
    "Relate `electionTimeoutMillis`, heartbeats, and catch-up to the observed outage.",
    "Choose a client timeout and retry policy that matches the failover budget.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
