import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Slot migration exposing non-redirecting cluster clients",
  accuracyNote:
    "This is an original composite scenario, not a real incident and not a real company incident. It combines common cluster-resharding, redirect-handling, and client-configuration failure modes into one representative scenario. It does not describe any company's architecture, traffic, dates, or internal decisions. All times are relative and all telemetry is illustrative.",
  architecture: { id: "hot-key-shards" },
  timeline: [
    {
      at: "T−1 day",
      title: "A reshard is planned to add capacity",
      body: "The cluster is running near its per-shard memory target. The team plans to move a batch of slots from two existing shards to a newly added node, in small increments.",
      tone: "info",
    },
    {
      at: "T+00:00",
      title: "Slot migration starts",
      body: "The first batch begins moving. The cluster remains available, but keys in migrating slots may receive ASK redirects until ownership changes, after which they receive MOVED.",
      tone: "info",
    },
    {
      at: "T+00:02",
      title: "One client tier begins failing",
      body: "A service reports command errors rather than cache misses. Its error rate rises only for keys in the moving slot range, so the aggregate looks like a partial degradation rather than a client problem.",
      tone: "warn",
    },
    {
      at: "T+00:05",
      title: "Redirects are being treated as failures",
      body: "Logs show MOVED responses surfaced directly as application errors. The client is connected in standalone mode to a single node and does not follow redirects or refresh its slot map.",
      tone: "danger",
    },
    {
      at: "T+00:09",
      title: "The migration is paused",
      body: "The operator stops issuing new slot moves. Already-migrated slots continue to redirect correctly for compliant clients, but the non-redirecting tier keeps failing for those keys.",
      tone: "warn",
    },
    {
      at: "T+00:25",
      title: "The client configuration is corrected",
      body: "The service is switched to a cluster-aware client configuration with redirect handling and slot-map refresh. It is deployed gradually, starting with a small canary.",
      tone: "info",
    },
    {
      at: "T+01:05",
      title: "Migration resumes in smaller batches",
      body: "The team moves a few slots at a time and watches redirect errors and latency after each batch. Each step has a defined point where it can stop without leaving a partially migrated slot.",
      tone: "warn",
    },
    {
      at: "T+02:30",
      title: "The reshard completes",
      body: "Slots are balanced across the new topology, and both redirect types are near zero. The client compatibility check becomes a prerequisite for future resharding.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-verify",
      prompt: "A reshard has started and one client tier is failing. What do you verify first?",
      options: [
        {
          id: "redirect-support",
          label: "Check whether that client follows MOVED and ASK and refreshes its slot map.",
          consequence:
            "The failure is attributed to client behavior rather than cluster health. The team knows which tier must change before migration can safely continue.",
          quality: "good",
        },
        {
          id: "cluster-health",
          label: "Check cluster state and node health before looking at clients.",
          consequence:
            "The cluster is likely healthy, so this confirms availability but not why one tier fails. Time passes while the migration continues to expose the incompatibility.",
          quality: "mixed",
        },
        {
          id: "restart-cluster",
          label: "Restart the cluster nodes to clear the redirect state.",
          consequence:
            "A restart does not make a non-redirecting client capable of following redirects. It adds availability risk and can interrupt migrations without fixing the failure.",
          quality: "poor",
        },
      ],
      debrief:
        "During slot migration, the cluster is allowed to redirect. A compliant client follows ASK temporarily and MOVED permanently, then refreshes its view. A standalone client sees those responses as errors. Check the client's redirect behavior before changing cluster state; the cluster is doing what resharding requires.",
    },
    {
      id: "mitigation",
      prompt: "The migration is partially complete and the bad client is still deployed. What do you do?",
      options: [
        {
          id: "pause-fix-resume",
          label: "Pause new slot moves, fix and canary the client, then resume in small batches.",
          consequence:
            "The blast radius stops growing while the incompatible client is corrected. Already-migrated slots remain valid, and the reshard can continue from a known boundary.",
          quality: "good",
        },
        {
          id: "push-through",
          label: "Complete the migration quickly so all redirects become MOVED and settle.",
          consequence:
            "Redirects do settle eventually, but the non-redirecting client fails for every moved key in the meantime. The fastest path through the migration increases the outage.",
          quality: "poor",
        },
        {
          id: "rollback-all",
          label: "Move every migrated slot back before fixing the client.",
          consequence:
            "Rollback may restore the old key placement, but it also causes redirects and can fail partway. It adds work without addressing the client that cannot follow them.",
          quality: "mixed",
        },
      ],
      debrief:
        "Pause first so the failure set stops expanding. Fix the client, prove it on a canary, then resume in bounded batches. A full rollback is not automatically safer: moving slots back is another migration with its own redirects and failure points. The goal is to reach a stable boundary, not to erase progress.",
    },
    {
      id: "lasting-control",
      prompt: "What should be required before any future slot migration?",
      options: [
        {
          id: "compatibility-gate",
          label: "A client redirect test, a staged slot batch plan, and redirect-error monitoring with a stop point.",
          consequence:
            "Incompatible clients are found before production slots move. Each batch has an observable gate and a place to stop, so the reshard can be halted without guesswork.",
          quality: "good",
        },
        {
          id: "maintenance-window",
          label: "Run resharding only during a maintenance window.",
          consequence:
            "A window reduces exposure but does not make a standalone client redirect-aware. The same errors occur, simply at a scheduled time.",
          quality: "mixed",
        },
        {
          id: "single-endpoint",
          label: "Point all clients at one stable cluster endpoint and skip client changes.",
          consequence:
            "A proxy or endpoint can hide topology, but it does not remove redirect semantics unless it handles them. The underlying client still needs a correct strategy.",
          quality: "poor",
        },
      ],
      debrief:
        "Resharding is a compatibility test as much as a capacity operation. Verify redirect handling in every client, move small batches, and watch ASK and MOVED errors as explicit signals. Define the stop point before starting. A maintenance window changes when the risk occurs, not whether the client can handle it.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "A slot migration began to rebalance a cluster. One service used a standalone client configuration that treated redirects as command failures. As slots moved, that service failed for the affected keys while compliant clients continued normally. The migration was paused and resumed only after the client was fixed.",
    },
    {
      type: "h3",
      text: "What made it worse",
    },
    {
      type: "list",
      items: [
        "Client redirect support was not part of the reshard prerequisite check.",
        "The first batch was large enough to expose many keys before the error signal was understood.",
        "Aggregate error rate hid a failure concentrated in one client tier and one slot range.",
        "No stop point was defined, so pausing required an ad hoc decision under pressure.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "Every client must pass a redirect test against a staging cluster before resharding.",
        "Slot moves run in small batches with a stop point and a post-batch health check.",
        "ASK and MOVED error rates are monitored per client and per slot range.",
        "Runbooks document how to pause safely and how to verify slot ownership afterward.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "A cluster can be healthy while a client is incompatible with it. During resharding, redirects are the protocol working as designed. The prerequisite is not cluster capacity but client capability: follow redirects, refresh topology, and handle connection changes. Move in small batches, watch the redirect signal, and know where to stop before starting.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, error rates, and slot observations in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Redis cluster specification",
      url: "https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/",
      publisher: "Redis",
      kind: "docs",
      note: "Slot ownership, MOVED and ASK redirection, and client behavior.",
    },
    {
      title: "Scaling with Redis Cluster",
      url: "https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/",
      publisher: "Redis",
      kind: "docs",
      note: "Adding nodes and migrating slots.",
    },
    {
      title: "CLUSTER SETSLOT",
      url: "https://redis.io/docs/latest/commands/cluster-setslot/",
      publisher: "Redis",
      kind: "docs",
      note: "Slot states used during migration.",
    },
  ],
};
