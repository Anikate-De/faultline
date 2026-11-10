import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Canary gate that validated error rate but not fleet-wide capacity",
  accuracyNote:
    "This is an original composite case file, not a real incident and not a real company incident. It combines common canary, connection-pool, and rollout-gate failure modes into one representative scenario. It does not describe any company's architecture, dates, traffic, or internal decisions. All relative times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "The canary receives five percent",
      body: "A new application version is deployed to a small set of pods and receives five percent of production traffic. The rollout blocks while the gate collects error rate and latency.",
      tone: "info",
    },
    {
      at: "T+00:30",
      title: "The gate passes",
      body: "Canary error rate is within a few hundredths of a percent of baseline, and p99 latency is slightly better. The gate has no capacity, connection, or fleet-projection check, so it marks the step healthy.",
      tone: "success",
    },
    {
      at: "T+00:35",
      title: "The full rollout starts",
      body: "The deployment replaces the remaining pods in batches. Each new pod opens its configured pool of forty database connections during startup.",
      tone: "info",
    },
    {
      at: "T+00:38",
      title: "New pods cannot connect",
      body: "The database's connection ceiling is reached. New pods retry, crash, and restart, while the old pods still hold their own connections. Error rate rises across every route, not only the new version.",
      tone: "danger",
    },
    {
      at: "T+00:42",
      title: "Autoscaling makes it worse",
      body: "The deployment's readiness failures raise the desired replica count. Additional pods start and attempt to open pools, adding connection churn to a database that is already refusing new sessions.",
      tone: "danger",
    },
    {
      at: "T+00:49",
      title: "The rollout is halted",
      body: "The release is paused and then rolled back. Old pods remain connected, so the rollback restores service without requiring a database restart.",
      tone: "warn",
    },
    {
      at: "T+01:14",
      title: "Traffic returns to baseline",
      body: "Error rate and latency recover as failed pods exit and the previous version stabilizes. The incident is contained, but the rollout is blocked pending a new gate.",
      tone: "success",
    },
    {
      at: "T+01:30",
      title: "The arithmetic is obvious",
      body: "At sixty pods, the new pool configuration would require 2,400 connections against a database budget of 800. At two canary pods it required eighty, which the database accepted without visible stress.",
      tone: "warn",
    },
  ],
  decisions: [
    {
      id: "rollout-failing",
      prompt: "New pods are failing to connect during the full rollout. What is the first move?",
      options: [
        {
          id: "halt-rollback",
          label: "Halt the rollout and roll back, keeping the old pods connected.",
          consequence:
            "Connection demand falls back to the previous fleet's level, and the database can serve existing sessions again. The team preserves a working version while it analyzes the pool math.",
          quality: "good",
        },
        {
          id: "raise-max",
          label: "Raise the database connection limit and continue the rollout.",
          consequence:
            "More sessions may be accepted briefly, but each new pod still opens a large pool and the database has finite memory per connection. The change increases the blast radius while the rollout continues.",
          quality: "poor",
        },
        {
          id: "scale-pods",
          label: "Scale the new deployment further so healthy pods can absorb the traffic.",
          consequence:
            "Additional pods add more connection attempts and restarts. Capacity that cannot establish a database session does not serve traffic, so the autoscaler amplifies the failure.",
          quality: "poor",
        },
      ],
      debrief:
        "When a rollout consumes a shared finite resource, stopping the rollout is the fastest way to stop the consumption. Raising the server limit treats the symptom and may destabilize the database further. The old pods are an asset during rollback because they already hold working connections.",
    },
    {
      id: "canary-gate",
      prompt: "What should the canary gate have checked?",
      options: [
        {
          id: "project-fleet",
          label:
            "Project fleet-wide pool demand against the database budget and test at target concurrency.",
          consequence:
            "The gate would fail before the full rollout because sixty pods times forty connections exceeds the shared ceiling. It converts a per-pod configuration into a system-level constraint.",
          quality: "good",
        },
        {
          id: "longer-canary",
          label: "Run the same five-percent canary for several more hours.",
          consequence:
            "A longer window may catch slow leaks, but it cannot reveal a limit that only appears at full fleet size. The gate stays green while the dangerous configuration remains.",
          quality: "mixed",
        },
        {
          id: "more-metrics",
          label: "Add CPU and memory saturation alerts to the canary.",
          consequence:
            "The new signals are useful for other failures, but the canary pods are not near their own limits. The shared database ceiling still sits outside the measured slice.",
          quality: "mixed",
        },
      ],
      debrief:
        "A canary is a sample, and some failures are not sampled proportionally. Resources that scale with pod count, deployed configuration, or aggregate client state need an explicit projection to full scale. Error rate at five percent answers whether the code works; it does not answer whether sixty copies of the configuration fit.",
    },
    {
      id: "lasting-control",
      prompt: "Which control should prevent the next version from repeating this?",
      options: [
        {
          id: "pool-budget",
          label:
            "Enforce a fleet-wide connection budget in config validation and use a pooler for shared access.",
          consequence:
            "Per-instance pools are bounded by the number of instances, and the deployment fails validation when the aggregate exceeds the database budget. A pooler adds a hop and some latency, but makes the shared limit explicit.",
          quality: "good",
        },
        {
          id: "smaller-pool",
          label: "Lower the per-pod pool from forty to twenty and keep the same rollout process.",
          consequence:
            "The immediate math improves, but the relationship is still implicit and the next instance-size or replica change can exceed the ceiling again. It buys margin without creating a guardrail.",
          quality: "mixed",
        },
        {
          id: "dba-approval",
          label: "Require a database administrator to approve pool changes manually.",
          consequence:
            "Human review can catch some changes, but approval does not test the deployed replica count or protect against autoscaling. It adds latency to every release without a continuous check.",
          quality: "mixed",
        },
      ],
      debrief:
        "Connection pools are per instance; database limits are global. The durable control is an explicit budget that ties the two together, enforced before deployment and verified after scaling. A pooler can centralize the limit, but it does not replace the arithmetic.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "A new version passed a five-percent canary on error rate and latency, then failed at full rollout because every pod opened a larger database pool. The aggregate exceeded the database's connection limit, new pods could not become ready, and autoscaling added more failed pods. Rollback restored service because the previous pods still held valid connections.",
    },
    {
      type: "h3",
      text: "Why the canary missed it",
    },
    {
      type: "list",
      items: [
        "The gate evaluated request outcomes on a small slice but did not project fleet-wide resource consumption.",
        "The database connection ceiling was documented per server, not budgeted per deployment and replica count.",
        "The canary's two pods used eighty connections, well below the ceiling, so the sample looked healthy.",
        "Autoscaling reacted to readiness failures by adding pods, which increased connection attempts rather than serving capacity.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "Deployment validation computes aggregate pool demand from the target replica count and rejects values above the database budget.",
        "The service connects through a pooler that enforces a shared session limit.",
        "Canary gates include a target-scale load test for resources that scale with fleet size.",
        "Rollout automation pauses on readiness failure instead of allowing autoscaling to amplify the attempt.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "A canary tests a version, not a fleet. Any resource whose demand grows with replica count, deployed configuration, or aggregate client state must be projected to the target scale before the gate can pass. The useful check is not only whether the sample is healthy, but whether the same configuration multiplied by the full fleet still fits inside every shared limit.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, percentages, and connection counts in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Canarying Releases",
      url: "https://sre.google/workbook/canarying-releases/",
      publisher: "Google SRE Workbook",
      kind: "book",
      note: "Canary population, metric selection, and gate design.",
    },
    {
      title: "CanaryRelease",
      url: "https://martinfowler.com/bliki/CanaryRelease.html",
      publisher: "Martin Fowler",
      kind: "docs",
      note: "Incremental rollout and the limits of a small traffic sample.",
    },
    {
      title: "Ensuring rollback safety during deployments",
      url: "https://aws.amazon.com/builders-library/ensuring-rollback-safety-during-deployments/",
      publisher: "AWS Builders' Library",
      kind: "docs",
      note: "Rollback planning and compatibility between deployed versions.",
    },
    {
      title: "Perform a Rolling Update on a Deployment",
      url: "https://kubernetes.io/docs/tutorials/kubernetes-basics/update/update-intro/",
      publisher: "Kubernetes Documentation",
      kind: "docs",
      note: "Rolling replacement behavior and readiness during rollout.",
    },
  ],
};
