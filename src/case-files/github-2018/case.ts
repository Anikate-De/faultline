import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "public",
  company: "GitHub",
  date: "October 21–22, 2018",
  incidentClass: "Network partition, cross-region database failover, and divergent writes",
  accuracyNote:
    "Verified against GitHub's October 30 post-incident analysis and its October 21 incident report. The timeline uses GitHub's published UTC timestamps; relative offsets are arithmetic from 22:52 UTC. GitHub published selected write counts and backlog figures, not a complete telemetry set; no other metrics, quotes, or internal deliberations are added. The report says no user data was lost, while manual reconciliation of a few seconds of writes was still in progress at publication; this file does not claim a later outcome.",
  timeline: [
    {
      at: "T+00:00 · 22:52 UTC",
      title: "A 43-second partition",
      body: "Routine maintenance to replace failing 100G optical equipment causes a loss of connectivity between GitHub's US East Coast network hub and its primary US East Coast data center. Connectivity returns in 43 seconds.",
      tone: "warn",
    },
    {
      at: "T+00:02 · 22:54 UTC",
      title: "Alerts and an unexpected topology",
      body: "Monitoring begins generating alerts. By 23:02 UTC, responders determine that many database clusters are in an unexpected state and that the Orchestrator API shows a topology containing only US West Coast servers.",
      tone: "warn",
    },
    {
      at: "T+00:15 · 23:07 UTC",
      title: "Change control tightened",
      body: "Responders lock the internal deployment tooling. The site goes yellow at 23:09 UTC, an incident coordinator joins at 23:11 UTC, and the status moves to red at 23:13 UTC.",
      tone: "danger",
    },
    {
      at: "T+00:21 · 23:13 UTC",
      title: "Two histories",
      body: "The West Coast cluster has ingested writes for nearly 40 minutes. The East Coast database contains several seconds of writes that never reached the West. Failing back would discard one side.",
      tone: "danger",
    },
    {
      at: "T+00:27 · 23:19 UTC",
      title: "Integrity over usability",
      body: "GitHub pauses webhook delivery and GitHub Pages builds. It accepts partial degradation rather than risk the data it has already received from users.",
      tone: "warn",
    },
    {
      at: "T+01:13 · 00:05 UTC",
      title: "The recovery plan",
      body: "The plan is to restore from backups, synchronize replicas in both sites, fall back to a stable topology, and resume queued jobs. Backups are taken every four hours and stored remotely; restoring multiple terabytes takes hours.",
      tone: "info",
    },
    {
      at: "T+12:20 · 11:12 UTC",
      title: "Primaries return to the East",
      body: "All database primaries are established in the US East Coast again. Dozens of read replicas remain hours behind, so users can still see inconsistent data depending on which replica serves a read.",
      tone: "warn",
    },
    {
      at: "T+17:32 · 16:24 UTC",
      title: "Failover to the original topology",
      body: "Replicas are in sync and GitHub fails over to the original topology. The site becomes more responsive, but the backlog of deferred work remains.",
      tone: "warn",
    },
    {
      at: "T+17:53 · 16:45 UTC",
      title: "The backlog comes due",
      body: "More than five million hook events and 80 thousand Pages builds are queued. As processing resumes, about 200,000 webhook payloads outlive an internal TTL and are dropped; GitHub pauses processing and extends the TTL.",
      tone: "warn",
    },
    {
      at: "T+24:11 · 23:03 UTC",
      title: "Green",
      body: "The backlog is processed and system integrity is confirmed. The site returns to green after 24 hours and 11 minutes of degradation.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "fail-direction",
      prompt: "Both data centers now hold writes the other does not have. Which direction do you fail?",
      options: [
        {
          id: "fail-forward",
          label: "Fail forward to the West and preserve the East writes for reconciliation.",
          consequence:
            "GitHub chose this to keep more than 30 minutes of West Coast writes. It accepted that East Coast applications would suffer cross-country latency and that the service would remain degraded.",
          quality: "good",
        },
        {
          id: "fail-back",
          label: "Fail back to the East and discard the West writes.",
          consequence:
            "This discards writes users had already made. GitHub said the West Coast data prevented it from considering anything other than failing forward.",
          quality: "poor",
        },
        {
          id: "dual-writes",
          label: "Let both sites continue accepting writes while replication is repaired.",
          consequence:
            "That deepens divergence and makes reconciliation harder. GitHub instead established one write direction and rebuilt replication around it.",
          quality: "poor",
        },
      ],
      debrief:
        "A partition turns a topology problem into a data-ownership problem. The first question is not which site is closer or faster; it is which writes already exist and whether either side can be discarded. GitHub chose the direction that preserved the larger body of writes, then spent the recovery time reconciling the smaller set. That choice protected data but kept the service degraded, which is the tradeoff the report makes explicit.",
    },
    {
      id: "degrade-scope",
      prompt: "The site can stay partially usable while the database topology is repaired. What do you pause?",
      options: [
        {
          id: "pause-writes",
          label: "Pause webhook delivery and Pages builds, keep reads and core Git available.",
          consequence:
            "GitHub made this explicit choice to avoid jeopardizing data. It prioritized integrity over site usability and time to recovery.",
          quality: "good",
        },
        {
          id: "keep-all",
          label: "Keep every feature on and repair replication underneath.",
          consequence:
            "New writes add to the divergence and backlog. GitHub paused write-heavy processing instead of accepting more data it might not be able to reconcile.",
          quality: "poor",
        },
        {
          id: "full-offline",
          label: "Take the entire site offline until the topology is perfect.",
          consequence:
            "This avoids new writes but removes read access that GitHub kept available. The report describes partial degradation, not a full shutdown.",
          quality: "mixed",
        },
      ],
      debrief:
        "Degradation is a dial, not a switch. GitHub kept the parts of the platform that did not add unsafe writes and paused the parts that did. That reduced the reconciliation problem while preserving useful service. The cost was visible: webhook consumers, Pages users, and GitHub's own ability to publish incident updates were affected. The report treats those costs as deliberate, not accidental.",
    },
    {
      id: "durable-fix",
      prompt: "What change most directly prevents a repeat?",
      options: [
        {
          id: "orchestrator-config",
          label: "Configure Orchestrator to prevent cross-region primary promotion.",
          consequence:
            "This is GitHub's first technical initiative. Orchestrator behaved as configured, but the application could not support the topology it created.",
          quality: "good",
        },
        {
          id: "more-replicas",
          label: "Add more read replicas in both regions.",
          consequence:
            "More replicas help read capacity and recovery, but they do not stop an automated failover from creating an unsupported cross-region primary.",
          quality: "mixed",
        },
        {
          id: "faster-response",
          label: "Rely on faster detection and response.",
          consequence:
            "GitHub explicitly says tighter operational controls and faster response are insufficient safeguards for a system this complex.",
          quality: "poor",
        },
      ],
      debrief:
        "The automated system did what it was told. The defect was the mismatch between its failover policy and the application's latency assumptions. Preventing cross-region promotion addresses that mismatch directly. The longer-term active/active/active work changes the application so a facility loss is tolerable, and chaos engineering tests the assumptions before they fail in production. Detection speed matters, but it cannot repair a topology the application cannot use.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A 43-second loss of connectivity between GitHub's East Coast network hub and its primary data center triggered an Orchestrator leadership change. The West Coast and public-cloud Orchestrator nodes formed a quorum and failed database clusters over to the West. When connectivity returned, both sites held writes the other did not have. GitHub failed forward to preserve the West Coast writes, accepted cross-country latency, and spent the next day restoring backups, rebuilding replication, and processing a large backlog.",
    },
    { type: "h3", text: "What made it worse" },
    {
      type: "list",
      items: [
        "Orchestrator promoted primaries across regional boundaries even though the application could not tolerate the added latency.",
        "Backups were remote and multi-terabyte; a full cluster rebuild had never been needed before.",
        "Read replicas fell hours behind, so the site could return inconsistent data depending on the replica.",
        "Pages was paused, so GitHub could not publish its own incident update as quickly as it wanted.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "Orchestrator configuration was adjusted to prevent cross-region primary promotion.",
        "GitHub accelerated its active/active/active initiative for facility-level N+1 redundancy.",
        "Status reporting moved toward component-level detail instead of a single red, yellow, or green state.",
        "GitHub began a systemic practice of fault injection and chaos engineering.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "Quorum answers who may write; it does not answer whether the application can serve from that writer. A failover policy is part of the application contract, not just a database setting. Recovery also has distinct phases: stop the divergence, restore a consistent copy, rebuild replication, then drain the backlog. Each phase has its own risk, and the incident is not over when the primary is back.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Time notation",
      body: "Relative offsets are arithmetic from GitHub's published 22:52 UTC start. The source gives clock times for each event; this file does not add intermediate timings or telemetry.",
    },
  ],
  sources: [
    {
      title: "October 21 post-incident analysis",
      url: "https://github.blog/2018-10-30-oct21-post-incident-analysis/",
      publisher: "GitHub Blog",
      kind: "postmortem",
      note: "Detailed timeline, fail-forward decision, recovery phases, and technical initiatives.",
    },
    {
      title: "October 21 Incident Report",
      url: "https://github.blog/2018-10-21-october21-incident-report/",
      publisher: "GitHub Blog",
      kind: "docs",
      note: "Initial official report: network partition, database failure, paused webhooks, no data loss.",
    },
    {
      title: "Orchestrator",
      url: "https://github.com/github/orchestrator",
      publisher: "GitHub",
      kind: "docs",
      note: "MySQL topology orchestration and Raft-based failover referenced in the analysis.",
    },
  ],
};
