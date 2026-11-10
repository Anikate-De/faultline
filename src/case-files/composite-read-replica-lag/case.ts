import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Read-after-write staleness from replica routing during replication lag",
  accuracyNote:
    "This is an original composite scenario, not a real incident and not a real company incident. It combines common replica-lag, read-routing, and session-consistency failure modes into one representative scenario. It does not describe any company's architecture, traffic, dates, or internal decisions. All times are relative and all telemetry is illustrative.",
  architecture: { id: "replica-lag" },
  timeline: [
    {
      at: "T+00:00",
      title: "A user saves a profile change",
      body: "The write goes to the primary and commits successfully. The application redirects the user back to the profile page, which is served from a read replica.",
      tone: "info",
    },
    {
      at: "T+00:01",
      title: "The old value appears",
      body: "The refresh reads from a replica that has not yet applied the commit. The page shows the previous value, and the user retries the save. The write succeeds again with the same result.",
      tone: "warn",
    },
    {
      at: "T+00:05",
      title: "Support sees a pattern",
      body: "Several users report changes that appear to revert. Reads are distributed round-robin across replicas, and one replica is visibly behind the others.",
      tone: "danger",
    },
    {
      at: "T+00:12",
      title: "Lag is real but the database is healthy",
      body: "The lagging replica is applying a large maintenance batch. Primary write latency and error rate are normal. The stale reads are a routing decision, not a failed commit.",
      tone: "info",
    },
    {
      at: "T+00:18",
      title: "Reads are pinned for affected sessions",
      body: "The team routes post-write reads for affected sessions to the primary for a short window. The workaround stops new reports while the lagging replica catches up.",
      tone: "warn",
    },
    {
      at: "T+00:55",
      title: "Replication lag returns to normal",
      body: "The maintenance batch is throttled and the replica catches up. Lag falls below one second, and round-robin reads stop returning stale data.",
      tone: "success",
    },
    {
      at: "T+01:20",
      title: "A session consistency policy is deployed",
      body: "The application records the write position and sends reads to the primary until that position is visible, then returns the session to replicas. Only reads that require freshness pay the cost.",
      tone: "success",
    },
    {
      at: "T+02:00",
      title: "Staleness becomes observable",
      body: "Dashboards now track replication lag and read-after-write violations separately, so a healthy database with a routing bug no longer looks like a healthy user experience.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-fix",
      prompt: "Writes are succeeding, but users see their own changes revert. What is the best immediate fix?",
      options: [
        {
          id: "pin-session",
          label: "Route the affected session's reads to the primary for a bounded window after its write.",
          consequence:
            "The user sees the committed value while the rest of the traffic stays on replicas. The fix is narrow, reversible, and does not require the lagging replica to be rebuilt.",
          quality: "good",
        },
        {
          id: "add-replica",
          label: "Add another replica and spread reads more evenly.",
          consequence:
            "A new replica does not make the lagging one current and may itself start behind. The user-visible staleness continues while topology becomes more complex.",
          quality: "poor",
        },
        {
          id: "flush-cache",
          label: "Invalidate the application cache for the affected profile.",
          consequence:
            "If the stale value came from the database replica, cache invalidation does not help. It may briefly add load and obscure the routing cause.",
          quality: "poor",
        },
      ],
      debrief:
        "The write committed, so the problem is where the next read went. Pinning the session to the primary for a short window restores read-your-writes with limited cost. Adding replicas changes capacity, not the freshness of the replica the user already hit. Invalidating a cache is only correct if the stale value was cached; verify the path first.",
    },
    {
      id: "lasting-model",
      prompt: "What is the right long-term consistency design for user-visible reads?",
      options: [
        {
          id: "scoped-consistency",
          label: "Track write position per session and route freshness-sensitive reads until the replica has caught up.",
          consequence:
            "Read-your-writes is guaranteed for the data that needs it, while replicas keep serving tolerant reads. The cost is paid only by sessions with recent writes.",
          quality: "good",
        },
        {
          id: "all-primary",
          label: "Send every read to the primary so no user can ever see stale data.",
          consequence:
            "Correctness is simple, but read scale is lost and the primary becomes the bottleneck. The design solves staleness by removing the capacity that replicas provide.",
          quality: "mixed",
        },
        {
          id: "eventual-only",
          label: "Document that reads are eventually consistent and ask users to refresh later.",
          consequence:
            "The system remains cheap, but it violates the expectation set by the save-and-redirect flow. Users interpret the old value as data loss and retry writes.",
          quality: "poor",
        },
      ],
      debrief:
        "Read-your-writes is a session guarantee, not a database-wide setting. The efficient design scopes it: remember the write position, compare it with replica progress, and use the primary only until the replica can satisfy that session. Sending all reads to the primary is correct but gives up replica capacity. Telling users to refresh treats a product bug as user error.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "A user's write committed on the primary, but the follow-up read was routed round-robin to a lagging replica. The page showed the old value, so the user retried and saw the same result. The database was healthy; the application had no notion of read-your-writes.",
    },
    {
      type: "h3",
      text: "Why it happened",
    },
    {
      type: "list",
      items: [
        "Read routing ignored whether a session had just written.",
        "Replica lag was monitored as an infrastructure metric, not as a user-visible correctness signal.",
        "One slow maintenance batch increased lag without affecting primary health.",
        "The save-and-redirect flow created an immediate read that required freshness.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "Sessions track their last write position and use the primary until a replica has applied it.",
        "Freshness-sensitive endpoints declare read-your-writes instead of using default routing.",
        "Replica lag and read-after-write violations are alarmed separately.",
        "Bulk maintenance work is throttled against replication delay.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "Replica lag is normal; stale reads become a bug when the product promises otherwise. Read-your-writes is best treated as a scoped session guarantee: track what the session wrote, compare it with replica progress, and use the primary only when necessary. Monitor the promise, not just the lag. A database that is healthy can still deliver a user experience that looks like data loss.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, lag values, and read observations in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "PostgreSQL hot standby",
      url: "https://www.postgresql.org/docs/current/hot-standby.html",
      publisher: "PostgreSQL",
      kind: "docs",
      note: "Replication delay and the eventual consistency of standby reads.",
    },
    {
      title: "Read your writes",
      url: "https://jepsen.io/consistency/models/read-your-writes",
      publisher: "Jepsen",
      kind: "docs",
      note: "Formal definition of the session guarantee.",
    },
    {
      title: "MySQL replication",
      url: "https://dev.mysql.com/doc/refman/8.4/en/replication.html",
      publisher: "Oracle",
      kind: "docs",
      note: "Replica processing and the relationship between primary commits and replica reads.",
    },
  ],
};
