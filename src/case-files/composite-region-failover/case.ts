import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Regional failover into a standby without production-scale capacity",
  accuracyNote:
    "This is an original composite case file, not a real incident and not a real company incident. It combines common failover, capacity, quota, and dependency-limit failure modes into one representative scenario. It does not describe any company's architecture, dates, traffic, or internal decisions. All relative times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "The primary region degrades",
      body: "A regional dependency begins returning errors to most requests. The primary region is reachable, but its success rate falls below the threshold that the failover runbook defines.",
      tone: "warn",
    },
    {
      at: "T+00:05",
      title: "Failover is declared",
      body: "The incident commander follows the runbook and shifts the global traffic policy to the standby region. Health checks there are green, and the standby has been serving a small internal workload for months.",
      tone: "info",
    },
    {
      at: "T+00:11",
      title: "Cutover completes",
      body: "Traffic reaches the standby within the expected window. The status page reports failover complete because the routing change has propagated and the region is accepting connections.",
      tone: "success",
    },
    {
      at: "T+00:18",
      title: "The standby saturates",
      body: "The standby's fleet was sized for its own baseline plus modest headroom, not for the primary's peak. CPU and database connections reach their limits, and latency climbs past the SLO.",
      tone: "danger",
    },
    {
      at: "T+00:26",
      title: "Scaling hits a ceiling",
      body: "The autoscaling group reaches a maximum that was set to control cost, and the shared database rejects new connections. Requesting higher quotas takes longer than the incident allows.",
      tone: "danger",
    },
    {
      at: "T+00:42",
      title: "Load is shed deliberately",
      body: "The team disables batch jobs, pauses non-critical background work, caps concurrency per caller, and serves critical flows with a reduced feature set. Error rate falls even though capacity has not changed.",
      tone: "warn",
    },
    {
      at: "T+01:35",
      title: "Critical traffic is stable",
      body: "The standby remains above its comfortable utilization but serves the priority paths within a relaxed objective. Users can complete the core transaction again.",
      tone: "success",
    },
    {
      at: "T+02:50",
      title: "Failback begins",
      body: "The primary region is confirmed healthy, and traffic returns in stages. The team keeps the standby at its reduced load until the primary has held for a full observation window.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "standby-saturated",
      prompt:
        "Failover has completed, but the standby is saturated and errors are rising. What is the first action?",
      options: [
        {
          id: "shed-load",
          label: "Shed low-priority work and cap concurrency until the critical paths fit.",
          consequence:
            "The standby can serve its most important traffic immediately. Some features are unavailable, but the core transaction succeeds and the team gains time to inspect quotas and dependency limits.",
          quality: "good",
        },
        {
          id: "scale-blindly",
          label: "Raise the autoscaling maximum and add standby instances as fast as possible.",
          consequence:
            "New instances may not launch before quotas or database connection limits block them. Even when they do, they add pressure to the shared dependency that is already the bottleneck.",
          quality: "mixed",
        },
        {
          id: "fail-back",
          label: "Fail back to the primary region because the standby cannot carry the load.",
          consequence:
            "The primary is still degraded, so the team reintroduces the original fault and adds a second routing change. Clients with cached or in-flight connections experience another disruption.",
          quality: "poor",
        },
      ],
      debrief:
        "A standby that receives traffic is not automatically a standby that can serve it. Once the region is saturated, the fastest useful lever is demand: remove work that does not need to happen during the incident and limit concurrency so queues do not consume the remaining capacity. Scaling is still worth pursuing, but it competes with quotas, image pull time, and shared dependency limits.",
    },
    {
      id: "rto-definition",
      prompt:
        "The status page says failover is complete, but users are still failing. When is the RTO actually met?",
      options: [
        {
          id: "user-success",
          label:
            "When the priority user journeys succeed at the agreed rate, not when routing changes.",
          consequence:
            "The incident remains open while the team works the real bottleneck. Stakeholders get an honest recovery estimate, and the RTO metric reflects the outcome customers experience.",
          quality: "good",
        },
        {
          id: "dns-change",
          label: "When the DNS or traffic policy has switched to the standby region.",
          consequence:
            "The milestone records an internal event rather than customer recovery. The team risks standing down while the standby is saturated and users cannot complete transactions.",
          quality: "poor",
        },
        {
          id: "health-check",
          label: "When the standby's health checks and synthetic probes are green.",
          consequence:
            "Health checks prove that some requests succeed, not that the region can carry production volume. A probe passing under light load can coexist with a saturated fleet.",
          quality: "mixed",
        },
      ],
      debrief:
        "Failover has several clocks: routing propagation, dependency readiness, capacity readiness, and user-visible recovery. The RTO should be measured on the last one. Otherwise an organization can report success while the standby is failing under the load it was just asked to take.",
    },
    {
      id: "dr-test",
      prompt: "Which test would have exposed the gap before the incident?",
      options: [
        {
          id: "full-load-cutover",
          label:
            "A full-load cutover at the production peak shape, including quotas and shared dependencies.",
          consequence:
            "The test reaches the standby's real limits and reveals connection ceilings, autoscaling caps, and missing warm capacity. It is expensive and disruptive, but it measures the claim the plan makes.",
          quality: "good",
        },
        {
          id: "health-check-test",
          label:
            "A quarterly check that the standby answers health probes and serves a test request.",
          consequence:
            "The test confirms reachability and nothing about capacity. It produces a green result that increases confidence without reducing the risk that matters.",
          quality: "poor",
        },
        {
          id: "restore-test",
          label: "A database restore exercise in the standby region.",
          consequence:
            "This validates data recovery but not the application fleet's ability to serve production traffic. It is useful as one component and insufficient as the whole failover test.",
          quality: "mixed",
        },
      ],
      debrief:
        "Disaster recovery tests often prove existence: the standby exists, the backup restores, the DNS record changes. Those checks do not prove sufficiency. A credible test drives the target load through the complete path, including the quotas and shared services that only bind at scale.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "The primary region degraded, and the team failed over to a standby that was healthy but undersized. The standby absorbed the routing change and then saturated on compute and database connections. The incident continued after failover because the plan had tested reachability, not capacity.",
    },
    {
      type: "h3",
      text: "Why the capacity math failed",
    },
    {
      type: "list",
      items: [
        "The standby was sized against its own small baseline, not the primary's measured peak.",
        "The autoscaling maximum reflected a cost target rather than a failover requirement.",
        "Database connections were budgeted per region but not per failover state, so two regions' worth of clients competed for one ceiling.",
        "Warm capacity was assumed to be available on demand, but instance launch and quota approval both took longer than the RTO.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "Failover capacity is reserved for the full primary peak plus a defined margin, and the reservation is checked in CI.",
        "The runbook now begins with load shedding and concurrency limits before traffic moves.",
        "RTO reporting uses user-journey success, with routing and health as intermediate milestones.",
        "A quarterly full-load cutover exercises quotas, dependencies, and the failback path.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "A disaster recovery plan is a capacity claim. Proving that the standby can accept a connection is not the same as proving it can serve the load. The useful questions are what peak the standby must carry, which limits scale with the fleet rather than the request rate, and how long each of those limits takes to raise. When the answers do not fit inside the RTO, the plan needs reserved capacity or a smaller failover scope, not a more optimistic runbook.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, utilization figures, and error observations in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title:
        "Disaster Recovery (DR) Architecture on AWS, Part I: Strategies for Recovery in the Cloud",
      url: "https://aws.amazon.com/blogs/architecture/disaster-recovery-dr-architecture-on-aws-part-i-strategies-for-recovery-in-the-cloud/",
      publisher: "AWS Architecture Blog",
      kind: "docs",
      note: "Recovery strategies, RTO/RPO tradeoffs, and standby capacity models.",
    },
    {
      title: "Static stability using Availability Zones",
      url: "https://aws.amazon.com/builders-library/static-stability-using-availability-zones/",
      publisher: "AWS Builders' Library",
      kind: "docs",
      note: "Why recovery should not depend on control-plane capacity that may be unavailable.",
    },
    {
      title: "Managing Load",
      url: "https://sre.google/workbook/managing-load/",
      publisher: "Google SRE Workbook",
      kind: "book",
      note: "Load shedding, concurrency limits, and capacity during overload.",
    },
    {
      title: "Addressing Cascading Failures",
      url: "https://sre.google/sre-book/addressing-cascading-failures/",
      publisher: "Google SRE",
      kind: "book",
      note: "How shared limits and retry behavior turn saturation into an outage.",
    },
  ],
};
