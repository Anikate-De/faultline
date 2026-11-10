import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Application reconnect storm after a successful database failover",
  accuracyNote:
    "This is an original composite case file, not a real incident and not a real company incident. It combines common database-failover, DNS-cache, connection-pool, and reconnect-storm failure modes into one representative scenario. It does not describe any company's architecture, dates, traffic, or internal decisions. All relative times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "The primary database fails",
      body: "The writer becomes unavailable after a storage-level failure. The managed service begins its automatic failover to the standby in another zone.",
      tone: "warn",
    },
    {
      at: "T+00:04",
      title: "The new writer is promoted",
      body: "The standby is promoted, replication catches up, and the provider's health check turns green. The database is available again, and the failover event is recorded as successful.",
      tone: "success",
    },
    {
      at: "T+00:07",
      title: "The application stays down",
      body: "Application error rate remains near eighty percent. Existing pooled connections point at the old writer, and new connection attempts begin retrying on a fixed delay.",
      tone: "danger",
    },
    {
      at: "T+00:11",
      title: "Reconnects arrive together",
      body: "Dozens of application instances retry at the same intervals with full pools. The new writer reaches its connection limit and refuses sessions, so the retries continue instead of settling.",
      tone: "danger",
    },
    {
      at: "T+00:16",
      title: "The bottleneck is located",
      body: "Database CPU and query latency are normal, but the connection count is at its ceiling. Application logs show pool acquisition failures and repeated attempts against a cached address.",
      tone: "warn",
    },
    {
      at: "T+00:22",
      title: "Demand and timing are changed",
      body: "The team reduces pool size per instance, adds randomized backoff to reconnects, and recycles pools in staggered groups. The writer's connection count falls below its limit.",
      tone: "info",
    },
    {
      at: "T+00:34",
      title: "Applications begin serving",
      body: "Connection acquisition succeeds, queries execute, and error rate drops. The remaining failures are instances still holding a cached address, which clear as their pools are recycled.",
      tone: "success",
    },
    {
      at: "T+01:20",
      title: "User traffic is fully restored",
      body: "The application SLO returns to normal. The database had recovered in four minutes; the application needed more than an hour because of how it reconnected.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "app-still-down",
      prompt:
        "The database says failover succeeded, but the application is still failing. What is the first move?",
      options: [
        {
          id: "reduce-reconnects",
          label: "Reduce pool size, add jittered backoff, and recycle pools in staggered groups.",
          consequence:
            "Connection demand falls below the writer's limit, and retries stop arriving in synchronized waves. Some instances take longer to recover, but the database can admit sessions steadily.",
          quality: "good",
        },
        {
          id: "raise-connections",
          label: "Raise the new writer's connection limit to accept every pool at once.",
          consequence:
            "More sessions may be admitted briefly, but the total demand still exceeds what the writer can serve efficiently. Memory and context switching rise, and the retry storm continues.",
          quality: "mixed",
        },
        {
          id: "restart-all",
          label: "Restart every application instance at once to force fresh connections.",
          consequence:
            "All instances reconnect simultaneously with empty pools. The new writer receives the largest possible burst at the worst moment, and the outage extends.",
          quality: "poor",
        },
      ],
      debrief:
        "Database failover restores the database; it does not restore the application's connection topology. After promotion, every client must re-resolve, reconnect, and rebuild its pool. If they all do it at once with full pools, they can overwhelm a healthy writer. Reducing concurrency and spreading retries is the first control.",
    },
    {
      id: "recovery-check",
      prompt: "How should the team decide that the application has recovered?",
      options: [
        {
          id: "end-to-end",
          label:
            "Run a synthetic transaction through the application's real pool and resolution path.",
          consequence:
            "The check proves that a user request can traverse DNS, pool acquisition, and a write against the new writer. It catches stale addresses and pool exhaustion that a database health check misses.",
          quality: "good",
        },
        {
          id: "db-health",
          label: "Confirm the managed database's health check is green.",
          consequence:
            "The database is healthy, but the application may still be unable to reach it. The milestone is necessary and not sufficient, and it can produce a premature all-clear.",
          quality: "poor",
        },
        {
          id: "db-cpu",
          label: "Wait until database CPU returns to its normal range.",
          consequence:
            "Low CPU can mean the database is healthy or that clients cannot connect at all. Without application-level success data, the signal is ambiguous.",
          quality: "mixed",
        },
      ],
      debrief:
        "Recovery has layers: the writer is promoted, the endpoint resolves, the pool connects, and a request succeeds. Each layer can fail independently. An end-to-end check is the only one that proves the user path works, and it should run continuously through the failover window.",
    },
    {
      id: "lasting-control",
      prompt: "Which change best reduces the next reconnect storm?",
      options: [
        {
          id: "pool-budget-jitter",
          label:
            "Set a per-instance pool budget, jitter reconnects, and test failover with the full application fleet.",
          consequence:
            "The aggregate connection count stays within the writer's capacity, and retries spread across time. The failover test exercises the same path users will take, including cached addresses and pool recycling.",
          quality: "good",
        },
        {
          id: "bigger-writer",
          label: "Choose a larger writer instance so it can absorb the full pool demand.",
          consequence:
            "Extra capacity creates margin, but it does not bound the reconnect burst or fix stale addresses. A larger fleet or a new pool default can exceed the new ceiling again.",
          quality: "mixed",
        },
        {
          id: "pin-address",
          label: "Pin the application to the writer's address to avoid DNS lookups.",
          consequence:
            "Pinning removes resolution from the path, but it also removes the indirection that makes failover possible. The next promotion requires a coordinated application change.",
          quality: "poor",
        },
      ],
      debrief:
        "The durable fix is to make the reconnect demand explicit and bounded: pool size times instance count must fit the writer, and retries need jitter. A stable endpoint is useful because it lets the provider move the writer without changing application configuration. Pinning an address trades that flexibility for a faster failure.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "The primary database failed and the managed service promoted a standby in four minutes. The application did not recover with it. Pooled connections still referenced the old writer, clients retried on synchronized schedules, and the new writer's connection limit was exhausted by the combined demand. Reducing pool size and adding jitter restored service; the application took over an hour to return to its SLO.",
    },
    {
      type: "h3",
      text: "Why recovery diverged",
    },
    {
      type: "list",
      items: [
        "The failover milestone measured database availability, not application success.",
        "Each instance kept a large pool and retried at a fixed interval, so reconnects arrived in waves.",
        "Some runtimes cached the resolved address beyond the DNS TTL, and pools held established connections.",
        "The aggregate connection demand had never been compared with the writer's connection limit.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "Failover runbooks include application-level verification through the real resolution and pool path.",
        "Reconnects use randomized exponential backoff with a cap, and pools recycle in staggered groups.",
        "Pool size is validated against the writer's connection budget for the full fleet.",
        "Regular failover drills run with the application fleet and measure time to first successful user transaction.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "A database failover is an infrastructure event; application recovery is a client-behavior event. Between them sit DNS caches, stale pool entries, and retry schedules that all become active at once. The useful recovery metric is time to a successful user transaction, and the useful control is a bounded, jittered reconnect path whose total demand fits the new writer.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, error rates, and connection observations in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "High Availability, Load Balancing, and Replication",
      url: "https://www.postgresql.org/docs/current/high-availability.html",
      publisher: "PostgreSQL Documentation",
      kind: "docs",
      note: "Failover, promotion, and client connection behavior.",
    },
    {
      title: "About Pool Sizing",
      url: "https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing",
      publisher: "HikariCP",
      kind: "docs",
      note: "Why large pools per instance multiply into database contention.",
    },
    {
      title: "Multi-AZ DB instance deployments",
      url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html",
      publisher: "Amazon RDS Documentation",
      kind: "docs",
      note: "Managed failover behavior and endpoint changes.",
    },
    {
      title: "Timeouts, retries, and backoff with jitter",
      url: "https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/",
      publisher: "AWS Builders' Library",
      kind: "docs",
      note: "Jittered retries and avoiding synchronized reconnect waves.",
    },
  ],
};
