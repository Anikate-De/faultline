import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "A representative API platform",
  date: "Not a dated incident",
  incidentClass: "Retry amplification after a dependency slowdown",
  accuracyNote:
    "This is a composite scenario, not a real incident. It combines common timeout, retry, breaker, and recovery failure modes into one representative scenario. It does not describe any company's architecture, dates, traffic, or internal decisions. All times are relative and all telemetry is illustrative.",
  architecture: { id: "request-path" },
  timeline: [
    {
      at: "T+00:00",
      title: "The shared dependency slows",
      body: "An inventory dependency slows under its own load. Callers keep a fixed deadline, so requests begin to expire while the dependency is still answering some of them.",
      tone: "warn",
    },
    {
      at: "T+00:40",
      title: "A deadline becomes a retry",
      body: "Client libraries retry on deadline-exceeded results. Each caller attempts the request again, so offered load rises while useful throughput falls.",
      tone: "warn",
    },
    {
      at: "T+02:10",
      title: "Thread pools fill",
      body: "Requests wait on retry timers and connection acquisition. Healthy endpoints slow because their callers are blocked on the same dependency.",
      tone: "danger",
    },
    {
      at: "T+04:00",
      title: "The breaker stays closed",
      body: "The breaker counts explicit server errors only. Deadline-exceeded results do not cross its failure threshold, so it keeps sending traffic into the slow path.",
      tone: "danger",
    },
    {
      at: "T+08:30",
      title: "The dependency recovers",
      body: "Dependency latency returns to its normal range. The retry budget still permits amplification, so callers keep generating more attempts than useful work.",
      tone: "info",
    },
    {
      at: "T+11:00",
      title: "Amplification becomes the incident",
      body: "Queues remain full and success rate stays low. The original trigger is gone; the retry policy is now the largest source of load.",
      tone: "danger",
    },
    {
      at: "T+17:00",
      title: "Retries are capped",
      body: "On-call disables retries at the edge and reduces the shared client budget. Offered load falls before any new capacity is added.",
      tone: "success",
    },
    {
      at: "T+31:00",
      title: "Traffic returns to baseline",
      body: "Queues drain and latency returns to the SLO. Capacity was never the first fix; reducing offered load was.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-mitigation",
      prompt: "The dependency is slow but still returning some responses. What is the first mitigation?",
      options: [
        {
          id: "cap-retries",
          label: "Disable retries at the edge and cap the shared client retry budget.",
          consequence:
            "Some transient errors surface immediately, but offered load falls and queues begin to drain. The team buys time to diagnose the dependency without adding more work.",
          quality: "good",
        },
        {
          id: "raise-timeout",
          label: "Raise the deadline so more requests can complete.",
          consequence:
            "Requests stay in flight longer and the dependency queue grows. Fast failures become slow failures, and retries still multiply the load.",
          quality: "poor",
        },
        {
          id: "add-capacity",
          label: "Scale the dependency horizontally as the primary response.",
          consequence:
            "Extra capacity may help later, but it cannot absorb retry amplification immediately and may not be available inside the incident window. The offered load keeps growing while it is provisioned.",
          quality: "mixed",
        },
      ],
      debrief:
        "Reducing offered load is the first move because retries multiply both request rate and concurrency. Scaling is a second-order fix: it changes capacity, not the policy that is creating demand. A useful test is to ask whether the system would recover if the dependency returned to normal right now. In this scenario, it would not, because callers would keep retrying.",
    },
    {
      id: "dependency-healthy",
      prompt: "The dependency is healthy again, but traffic and errors remain high. What do you check next?",
      options: [
        {
          id: "breaker-and-budget",
          label: "Check breaker state, retry budgets, and queue depth at every caller.",
          consequence:
            "The remaining load is traced to caller behavior rather than dependency health. The team can reduce retries deliberately instead of waiting for the dependency to fail again.",
          quality: "good",
        },
        {
          id: "dependency-dashboard",
          label: "Confirm the dependency dashboard is green and treat the load as real demand.",
          consequence:
            "The dependency looks healthy, so the team misses amplification that originates in callers. Queues stay full and the incident continues without a clear cause.",
          quality: "poor",
        },
        {
          id: "rollback",
          label: "Roll back the most recent deploy as the first action.",
          consequence:
            "A rollback adds change during recovery and may not address the retry policy. Without a timeline correlation, it can remove a healthy version and prolong the outage.",
          quality: "poor",
        },
      ],
      debrief:
        "Recovery has two halves: dependency health and caller behavior. A green dependency dashboard answers only the first question. Breaker state, retry budgets, and queue depth show whether callers are still amplifying demand. Dependency recovery does not imply application recovery.",
    },
    {
      id: "lasting-control",
      prompt: "What control should prevent the next occurrence?",
      options: [
        {
          id: "budget-and-breaker",
          label: "Adopt a per-caller retry budget and count deadline-exceeded results as breaker failures.",
          consequence:
            "Amplification is bounded before it can dominate the system, and the breaker reacts to the failure mode that actually occurred. The team keeps retries for transient errors without allowing them to become a load source.",
          quality: "good",
        },
        {
          id: "shorter-timeout",
          label: "Lower the global timeout and leave retry behavior unchanged.",
          consequence:
            "Requests spend less time waiting, but the number of attempts can rise and the amplification remains hidden. The change may improve one symptom while making the underlying policy more aggressive.",
          quality: "mixed",
        },
        {
          id: "no-retries",
          label: "Remove retries from every caller.",
          consequence:
            "Amplification disappears, but so does resilience to brief, independent failures. Availability can fall for unrelated transient errors that a bounded retry policy would have absorbed.",
          quality: "poor",
        },
      ],
      debrief:
        "The durable fix is a budget, not a binary switch. A retry budget caps retries as a fraction of successful traffic, backoff with jitter prevents synchronized waves, and the breaker must classify deadline-exceeded outcomes as failures. Together they keep retries useful without letting them outlive the original failure.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "A shared dependency slowed, and callers responded by retrying. The retries increased concurrency and queue depth, which made the dependency slower still. When the dependency recovered, the retry policy kept generating excess load, so the incident continued after its original cause disappeared.",
    },
    {
      type: "h3",
      text: "What made it worse",
    },
    {
      type: "list",
      items: [
        "Retry decisions were local to each caller, so no one owned the total amplification.",
        "The breaker counted only explicit server errors and ignored deadline-exceeded results.",
        "Backoff existed but lacked jitter, so retries arrived in synchronized waves.",
        "Dashboards showed dependency latency and caller error rate but not retry attempts or queue depth per caller.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "A per-caller retry budget caps retries as a fraction of successful requests.",
        "Breakers classify deadline-exceeded outcomes as failures and open on sustained rates.",
        "Backoff uses jitter, and the edge can shed low-priority traffic before queues saturate.",
        "Dashboards pair dependency health with caller retry rate, queue depth, and breaker state.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "Retry amplification is a load-management problem, not only a client-library setting. The system needs a shared limit on total retry work, a breaker that recognizes the actual failure mode, and a recovery check that asks whether callers have stopped amplifying. Adding capacity before reducing offered load can make the queue larger and the recovery slower.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, rates, and queue observations in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Timeouts, retries, and backoff with jitter",
      url: "https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/",
      publisher: "AWS Builders' Library",
      kind: "docs",
      note: "Retry budgets, backoff, jitter, and retry amplification.",
    },
    {
      title: "Addressing Cascading Failures",
      url: "https://sre.google/sre-book/addressing-cascading-failures/",
      publisher: "Google SRE",
      kind: "book",
      note: "Cascading failure, retry storms, and load management.",
    },
    {
      title: "Circuit breaking",
      url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/circuit_breaking",
      publisher: "Envoy Project",
      kind: "docs",
      note: "Breaker thresholds and outlier detection in a service proxy.",
    },
    {
      title: "Managing Load",
      url: "https://sre.google/workbook/managing-load/",
      publisher: "Google SRE Workbook",
      kind: "book",
      note: "Load shedding, capacity, and overload response.",
    },
  ],
};
