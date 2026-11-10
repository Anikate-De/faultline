import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-keepalive-idle-timeout",
  slug: "keepalive-idle-timeout",
  title: "Keep-Alive and Idle Timeout Mismatch",
  track: "traffic",
  order: 23,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["traffic-connection-draining"],
  tags: ["keep-alive", "idle timeout", "connection reuse", "race", "502"],
  productionQuestion:
    "The ALB opens a new backend connection for almost every request. Which timeout is misaligned?",
  learningDelta:
    "Keep-alive must outlive the load balancer's idle timeout; if the backend closes first, requests race and connections churn",
  objectives: [
    "Compare the load balancer idle timeout with the backend keep-alive timeout.",
    "Explain why a backend that closes first creates both churn and 502 responses.",
    "Diagnose the race from connection counts and 502s rather than target health.",
    "Choose which timeout to change and state the cost of the choice.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
