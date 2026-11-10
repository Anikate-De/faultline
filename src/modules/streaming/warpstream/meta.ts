import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-warpstream",
  slug: "warpstream",
  title: "WarpStream on Object Storage",
  track: "streaming",
  order: 20,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["streaming-kafka-partitions"],
  tags: ["WarpStream", "object storage", "S3", "latency", "cost", "stateless broker"],
  productionQuestion:
    "A Kafka-compatible service stores data in object storage. What changes for latency and cost?",
  learningDelta:
    "Object-storage streaming trades broker-local disk for S3 latency and cost; tail latency and metadata operations dominate",
  objectives: [
    "Explain how a Kafka-compatible service can keep data in object storage instead of broker disks.",
    "Relate batch interval and partition count to object request rate, latency, and cost.",
    "Distinguish throughput capacity from tail latency in an object-storage streaming design.",
    "Choose when the architecture fits and when broker-local storage is still required.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
