import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Latency dominated by client-side connection pool wait",
  accuracyNote:
    "This is an original composite scenario, not a real incident and not a real company incident. It combines common connection-pool, transaction-hold, and latency-attribution failure modes into one representative scenario. It does not describe any company's architecture, traffic, dates, or internal decisions. All times are relative and all telemetry is illustrative.",
  architecture: { id: "request-path" },
  timeline: [
    {
      at: "T+00:00",
      title: "Application p99 crosses the latency SLO",
      body: "The service latency alarm fires at roughly two seconds at p99. Error rate is still low, but requests are queuing and the SLO burn rate is rising.",
      tone: "warn",
    },
    {
      at: "T+00:03",
      title: "The database looks healthy",
      body: "Database CPU is low, connections are far below the server limit, and the slow-query log shows execution times around 20ms. The obvious database explanations do not fit.",
      tone: "info",
    },
    {
      at: "T+00:06",
      title: "Pool metrics show the queue",
      body: "Every application instance reports its pool fully checked out. Acquisition time has risen from under a millisecond to nearly two seconds, while query execution time remains flat.",
      tone: "danger",
    },
    {
      at: "T+00:12",
      title: "One endpoint holds connections too long",
      body: "A recently added endpoint acquires a connection, starts a transaction, then makes an external call before committing. The external call is slow under current load, so each request occupies a connection for far longer than its query.",
      tone: "danger",
    },
    {
      at: "T+00:18",
      title: "The endpoint is disabled",
      body: "On-call turns off the new endpoint and rolls back its release. Connection hold time falls immediately, and the wait queue begins to shrink.",
      tone: "warn",
    },
    {
      at: "T+00:40",
      title: "Latency returns to baseline",
      body: "Pool acquisition time falls below 5ms and p99 returns inside the SLO. Database load barely changes because the database was never the bottleneck.",
      tone: "success",
    },
    {
      at: "T+01:30",
      title: "Acquisition time becomes a first-class metric",
      body: "The team adds pool wait histograms, checked-out counts, and hold-time traces per endpoint, then sets alerts on wait rather than only on query latency.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "where-is-the-time",
      prompt: "Application latency is two seconds but database query time is 20ms. Where do you look first?",
      options: [
        {
          id: "acquisition-vs-execution",
          label: "Compare pool acquisition time with query execution time per instance.",
          consequence:
            "The gap is localized to the client pool before the database. The team sees full checkout and long hold times, which points at a code path rather than database capacity.",
          quality: "good",
        },
        {
          id: "add-replica",
          label: "Add a read replica and route reads to it.",
          consequence:
            "The database is already healthy, so another replica adds topology and cost without reducing pool wait. The queue remains at the application layer.",
          quality: "poor",
        },
        {
          id: "increase-pool",
          label: "Raise the maximum pool size on every instance.",
          consequence:
            "More connections may shorten the wait briefly, but they also increase concurrency against the same dependency and hide the hold-time problem. The fix can move the bottleneck downstream.",
          quality: "mixed",
        },
      ],
      debrief:
        "A request can spend time waiting for a connection before any query starts. If database execution time is low while end-to-end latency is high, the missing time is in acquisition, queueing, or application work. Pool metrics answer that question directly. Adding database capacity cannot fix a queue that exists before the database is contacted.",
    },
    {
      id: "lasting-fix",
      prompt: "What change best prevents pool wait from becoming the dominant latency again?",
      options: [
        {
          id: "hold-time-and-instrumentation",
          label: "Keep connection hold time short, isolate workloads, and alert on acquisition latency.",
          consequence:
            "The pool stays available for requests that need it, noisy workloads cannot consume every connection, and the next queue is visible before users feel it.",
          quality: "good",
        },
        {
          id: "large-pool",
          label: "Set a very large maximum pool and let the database absorb the concurrency.",
          consequence:
            "Wait time falls on paper, but the database now receives more concurrent work and may become the bottleneck. Connection count becomes a new capacity risk.",
          quality: "mixed",
        },
        {
          id: "query-timeout",
          label: "Add a query timeout and leave connection handling unchanged.",
          consequence:
            "Slow queries fail sooner, but a connection held during an external call is not a slow query. The pool can remain exhausted while timeouts fire elsewhere.",
          quality: "poor",
        },
      ],
      debrief:
        "Pool size is a concurrency limit, not a latency setting. The durable fix is to reduce how long a request holds a connection, separate pools for workloads with different behavior, and measure acquisition time. A large pool can hide the symptom by moving pressure into the database. An end-to-end timeout helps only when the blocked step is the query itself.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "A new endpoint held a database connection across a slow external call. Under rising traffic, connections stayed checked out long enough that the fixed-size pool saturated. Requests then waited nearly two seconds to acquire a connection before running a 20ms query. The database remained healthy throughout.",
    },
    {
      type: "h3",
      text: "Why it was misdiagnosed",
    },
    {
      type: "list",
      items: [
        "Latency dashboards reported end-to-end time but not pool acquisition time.",
        "Database health was measured at the server, where the queue did not exist.",
        "The pool had no per-endpoint hold-time visibility, so a single slow path was invisible.",
        "Connection hold time was not traced, so the slow endpoint looked identical to a fast one.",
        "The first instinct was to add database capacity, which could not address client-side queueing.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "Pool wait and checked-out duration are recorded as separate metrics with alerts.",
        "Connections are not held across external calls; long work is split from transaction scope.",
        "Critical and background workloads use separate pools with independent limits.",
        "Acquisition timeouts fail fast instead of allowing requests to queue indefinitely.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "End-to-end latency is a sum of queueing, acquisition, execution, and application work. When one layer looks healthy, the missing time is usually in a queue that layer does not own. Measure acquisition separately, treat pool size as a concurrency control, and watch hold time. A pool that is fully checked out is a queue, even when every query is fast. Size it for the work that must hold a connection, and alert on wait before users feel it.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, latency values, and pool observations in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "HikariCP pool sizing and configuration",
      url: "https://github.com/brettwooldridge/HikariCP",
      publisher: "HikariCP",
      kind: "docs",
      note: "Pool sizing, connection timeout, and hold-time behavior.",
    },
    {
      title: "PgBouncer configuration",
      url: "https://www.pgbouncer.org/config.html",
      publisher: "PgBouncer",
      kind: "docs",
      note: "Pool modes, client limits, and server connection limits.",
    },
    {
      title: "PostgreSQL monitoring database activity",
      url: "https://www.postgresql.org/docs/current/monitoring.html",
      publisher: "PostgreSQL",
      kind: "docs",
      note: "Server-side activity and connection state versus client queueing.",
    },
  ],
};
