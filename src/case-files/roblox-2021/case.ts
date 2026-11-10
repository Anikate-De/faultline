import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "public",
  company: "Roblox",
  date: "October 28–31, 2021",
  incidentClass: "Cascading control-plane failure in Consul",
  accuracyNote:
    "Verified against Roblox's postmortem, published January 20, 2022, including HashiCorp's analysis. Times are Pacific as stated. Roblox gives 73 hours as the outage duration; the timeline uses day markers rather than computed offsets because the first signal (13:37) and full recovery (16:45) span about 75 hours. Intermediate times that are not public are omitted. The BoltDB cause was determined after service returned. No telemetry beyond published figures is reconstructed.",
  timeline: [
    {
      at: "Day −1 · Oct 27 14:00",
      title: "Streaming reaches the traffic-routing service",
      body: "Roblox enables Consul's streaming feature on the backend service responsible for traffic routing. To prepare for end-of-year load, it also increases the nodes supporting that service by 50%. The system runs normally for about a day.",
      tone: "info",
    },
    {
      at: "Day 0 · 13:37",
      title: "The first signal",
      body: "Vault performance degrades and one Consul server shows high CPU. Players are not yet affected. The team finds Consul KV write latency at about two seconds, where it is normally under 300 milliseconds, and suspects hardware.",
      tone: "warn",
    },
    {
      at: "Day 0 · 16:35",
      title: "Players drop to half",
      body: "Consul cannot keep service discovery current. Nomad cannot schedule containers and Vault cannot issue production secrets. Online players fall to 50% of normal, and the degradation becomes a complete outage.",
      tone: "danger",
    },
    {
      at: "Day 0 · 19:00",
      title: "Vertical scaling does not help",
      body: "Most Consul nodes are moved to 128-core machines with faster disks. The cluster remains unhealthy. The team later learns that the dual-socket NUMA architecture made the contention worse, not better.",
      tone: "danger",
    },
    {
      at: "Day 1 · 02:00",
      title: "A snapshot reset",
      body: "The cluster is shut down and reset from a snapshot taken a few hours before the outage. Access is blocked with iptables and then removed. Service discovery load returns, and KV write latency climbs back to two seconds.",
      tone: "warn",
    },
    {
      at: "Day 1 · 04:00",
      title: "Reducing Consul's load",
      body: "A second attempt disables non-essential Consul usage, scales services to single digits, and lowers health checks from 60 seconds to 10 minutes. The cluster looks healthy, then degrades again by the next day.",
      tone: "warn",
    },
    {
      at: "Day 2 · 15:51",
      title: "Streaming is disabled",
      body: "Consul server flame graphs point to the streaming code path. Disabling streaming everywhere drops median KV write latency from two seconds to 300 milliseconds. Slow leaders remain, so the team prevents the problematic leaders from staying elected.",
      tone: "success",
    },
    {
      at: "Day 3 · 16:45",
      title: "All players return",
      body: "After rebuilding the cache tier and restarting services, Roblox uses DNS steering to admit players in roughly 10% increments, checking database and cache health each time. At 16:45, 100% of players have access, 73 hours after the outage began.",
      tone: "success",
    },
    {
      at: "After recovery",
      title: "The second root cause",
      body: "HashiCorp later finds the slow-leader cause in BoltDB: a 4.2GB Raft log held 489MB of data, and its freelist had grown to 7.8MB. Each 16KB write rewrote that freelist, producing multi-second writes. Compaction and a move to bbolt address it.",
      tone: "info",
    },
  ],
  decisions: [
    {
      id: "first-hypothesis",
      prompt:
        "Consul write latency is about two seconds instead of under 300 milliseconds, one node has high CPU, and no recent change is obviously responsible. What do you try first?",
      options: [
        {
          id: "hardware-replace",
          label: "Replace the suspect hardware, then scale the cluster vertically if it does not recover.",
          consequence:
            "A reasonable first hypothesis at this scale, but replacing and upgrading nodes consumes hours. The 128-core machines make contention worse because of their dual-socket memory layout.",
          quality: "mixed",
        },
        {
          id: "disable-recent-feature",
          label: "Disable the most recent feature change and observe the cluster before changing hardware.",
          consequence:
            "This is the change that produced the breakthrough: disabling streaming brings KV writes back to 300 milliseconds. In hindsight it is the fastest path, though the feature had run for a day and on other services for months.",
          quality: "good",
        },
        {
          id: "restart-cluster",
          label: "Restart the whole Consul cluster and let Raft re-elect a leader.",
          consequence:
            "A restart does not remove the source of contention. It also adds a leader election during an outage and can reset state that other systems depend on.",
          quality: "poor",
        },
      ],
      debrief:
        "Hardware failure and load saturation look similar: high CPU, slow writes, an unhealthy cluster. Roblox ruled out hardware by replacing it and capacity by scaling up, which took hours. The discipline is to time-box a hypothesis and test recent changes before treating the symptom as infrastructure. Streaming had worked at this level for a day, so the change was not obvious.",
    },
    {
      id: "diagnosis-while-blind",
      prompt:
        "The telemetry stack depends on Consul, so the dashboards that would explain the outage are degraded too. How do you proceed?",
      options: [
        {
          id: "out-of-band",
          label: "Use host-level logs, perf data, and operating-system metrics that do not traverse Consul.",
          consequence:
            "The team can see blocked writes and kernel spin locks even while the normal observability path is impaired. This is how the streaming code path was eventually identified.",
          quality: "good",
        },
        {
          id: "wait-for-metrics",
          label: "Wait for the normal metrics pipeline to recover before drawing conclusions.",
          consequence:
            "The outage continues while the team is blind. The dependency that caused the failure also controls the evidence, so waiting cannot produce a diagnosis.",
          quality: "poor",
        },
        {
          id: "restart-until-clear",
          label: "Keep restarting components until the dashboards return to normal.",
          consequence:
            "Restarts add churn and reset state without isolating the fault. They can also destroy the evidence needed to find it.",
          quality: "poor",
        },
      ],
      debrief:
        "Observability is part of the control plane when it shares the same dependencies. Roblox's telemetry depended on Consul, so the failure removed the data that would have shortened it. The workaround was a lower-level path that still worked. Afterward, Roblox removed the circular dependency and added targeted Consul and BoltDB alerts.",
    },
    {
      id: "recovery-sequence",
      prompt:
        "Consul is stable and the caches are unhealthy. What is the safest path back to serving players?",
      options: [
        {
          id: "sequence-and-ramp",
          label:
            "Rebuild caches, validate each dependency layer, then admit traffic gradually with DNS steering.",
          consequence:
            "Each layer is proven before the next depends on it. A controlled ramp catches instability while the blast radius is small, and it avoids a cold-cache flood that could push Consul over again.",
          quality: "good",
        },
        {
          id: "open-all",
          label: "Open traffic to 100% as soon as Consul reports healthy.",
          consequence:
            "Consul health does not prove that caches, scheduling data, and service capacity are ready. A full cold-start load can return the cluster to the state that caused the outage.",
          quality: "poor",
        },
        {
          id: "restore-cache-snapshot",
          label: "Restore the cache tier from its previous snapshot and start serving immediately.",
          consequence:
            "The snapshot may contain stale scheduling data, and the cache deployment tooling was built for incremental changes rather than a cold start. This path produced deployment failures during the incident.",
          quality: "mixed",
        },
      ],
      debrief:
        "Recovery is a dependency-ordering problem. Consul had to be healthy before Nomad and Vault worked; caches had to be rebuilt before services served; services had to be verified before players returned. Roblox admitted players in roughly 10% increments, checking database and cache health at each step. The care was appropriate, but the cache tooling's inability to bootstrap from scratch was itself a reliability gap.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "Roblox ran service discovery, health checks, session locking, and a key-value store on one Consul cluster; Nomad and Vault depended on it. A Consul streaming feature, enabled on the traffic-routing service one day earlier, caused severe contention under high read and write load. A second, unrelated BoltDB freelist pathology made some leaders write several seconds behind. Consul became unhealthy, and the services that depended on it could not schedule work or retrieve secrets.",
    },
    { type: "h3", text: "Why the outage lasted 73 hours" },
    {
      type: "list",
      items: [
        "Two independent faults presented as one symptom, and neither was visible in the normal metrics.",
        "A single Consul cluster served many workloads, so its failure had no narrow blast radius.",
        "The observability stack depended on Consul, removing the evidence responders needed.",
        "Hardware replacement and a snapshot reset were reasonable attempts that did not address either fault.",
        "The cache deployment tooling supported incremental changes, not a cold bootstrap of the whole tier.",
        "Bringing a fully stopped platform back required careful sequencing and verification.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "The telemetry circular dependency was removed, and Consul and BoltDB got targeted alerts.",
        "Critical services were split onto dedicated Consul clusters and obsolete KV data was deleted.",
        "Roblox began redesigning cache deployment and Nomad job startup for cold starts.",
        "Roblox accelerated work on multiple availability zones and a second data center.",
        "Consul moved toward bbolt, whose freelist does not grow without bound.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "A control plane can fail while the data plane is still capable of serving. The dependency graph is the real availability boundary: discovery, scheduling, secrets, and telemetry can all be one failure domain. A service that is not needed to serve a request may still be needed to change, scale, or recover the system.",
    },
    {
      type: "p",
      text: "Two faults can hide each other. Streaming contention explained most of the latency, but slow leaders persisted after it was disabled; only post-incident analysis found the BoltDB freelist amplification. Incident response has to tolerate partial explanations and keep a workaround available without pretending the root cause is fully understood.",
    },
    {
      type: "callout",
      tone: "info",
      title: "What responders knew, and when",
      body: "The BoltDB cause was not identified during the outage. Roblox restored service with streaming disabled and a workaround for slow leaders, then continued analysis with HashiCorp. This case does not attribute knowledge to responders that they did not have at the time.",
    },
  ],
  sources: [
    {
      title: "Roblox Return to Service 10/28–10/31 2021",
      url: "https://about.roblox.com/newsroom/2022/01/roblox-return-to-service-10-28-10-31-2021",
      publisher: "Roblox",
      kind: "postmortem",
      note: "Primary source for the timeline, both root causes, recovery, and follow-up work.",
    },
    {
      title: "Roblox's cloud-native catastrophe: A post mortem",
      url: "https://www.infoworld.com/article/2334415/robloxs-cloud-native-catastrophe-a-post-mortem.html",
      publisher: "InfoWorld",
      kind: "docs",
      note: "Independent analysis used to cross-check the Consul and BoltDB explanations.",
    },
  ],
};
