import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-linux-disk-io",
  slug: "linux-disk-io",
  title: "Disk I/O: IOPS, Queue Depth, and fsync",
  track: "foundations",
  order: 19,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["foundations-linux-cpu"],
  tags: ["IOPS", "throughput", "queue depth", "fsync", "write amplification", "iowait"],
  productionQuestion:
    "Disk utilization is 100% and writes take 300ms; is the device slow or overloaded?",
  learningDelta:
    "IOPS, throughput, and queue depth are different limits; fsync latency exposes durability cost",
  objectives: [
    "Separate an IOPS limit from a throughput limit.",
    "Read queue depth and await together under write pressure.",
    "Explain why fsync latency is a durability signal, not just a slow write.",
    "Choose between more IOPS, more throughput, smaller I/O, and less write amplification.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
