import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "kubernetes-incident-debug",
  slug: "incident-debug",
  title: "Cluster Incident Triage",
  track: "kubernetes",
  order: 16,
  difficulty: 4,
  minutes: 20,
  prerequisites: ["kubernetes-node-pressure", "kubernetes-probes"],
  tags: ["triage", "events", "pending", "crashloop", "notready", "logs"],
  productionQuestion: "Half the pods are Pending, some CrashLoop, and one node is NotReady. What order?",
  learningDelta:
    "Cluster triage walks node, scheduler, pod, container, and app using events and status before logs; symptoms often originate below",
  objectives: [
    "Order evidence from node conditions to scheduler events to container logs.",
    "Distinguish Pending, CrashLoopBackOff, and NotReady by the layer that produces them.",
    "Recognize when logs are the wrong first tool.",
    "Reduce time to root cause by following the dependency direction.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
