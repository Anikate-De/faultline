import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "public",
  company: "Meta (Facebook)",
  date: "October 4, 2021",
  incidentClass: "Backbone misconfiguration leading to BGP withdrawal and DNS unreachability",
  accuracyNote:
    "Verified against Meta's October 5 engineering post and Cloudflare's external BGP and DNS observations. Meta did not publish the exact time of the maintenance command or a minute-by-minute internal timeline; internal actions are described in the order Meta reported them, not at invented timestamps. Cloudflare's relative offsets are derived from its published UTC observations at about 15:40, 15:50, 15:58, 21:00, 21:17, and 21:28 UTC. No telemetry, quotes, or internal decisions beyond those sources are presented.",
  timeline: [
    {
      at: "T+00:00 · approx. 15:40 UTC",
      title: "A maintenance command removes the backbone",
      body: "During routine maintenance, a command intended to assess global backbone capacity takes down all connections in the backbone. Meta later says a bug in the audit tool prevented the command from being stopped.",
      tone: "danger",
    },
    {
      at: "T+00:10 · approx. 15:50 UTC",
      title: "DNS stops resolving",
      body: "Cloudflare observes facebook.com and related names stop resolving through public resolvers. Meta says its DNS servers were still operational, but the network path to them was gone.",
      tone: "danger",
    },
    {
      at: "T+00:18 · 15:58 UTC",
      title: "BGP advertisements are withdrawn",
      body: "Cloudflare observes that Facebook has stopped announcing routes to its DNS prefixes. Meta explains that its DNS servers withdraw BGP advertisements when they cannot reach the data centers, because that is how they declare themselves unhealthy.",
      tone: "danger",
    },
    {
      at: "T+00:18 onward",
      title: "The management plane fails with the service",
      body: "Meta says both normal and out-of-band network access were down. Engineers go onsite, but physical and system security controls slow access; secure access protocols must be activated before work can begin.",
      tone: "danger",
    },
    {
      at: "T+05:20 · approx. 21:00 UTC",
      title: "BGP activity returns",
      body: "Cloudflare sees renewed BGP activity from Facebook's network, peaking at about 21:17 UTC.",
      tone: "info",
    },
    {
      at: "T+05:48 · 21:28 UTC",
      title: "The Internet can reach Facebook again",
      body: "Cloudflare reports Facebook reconnected and DNS working. Meta describes a careful ramp: restoring everything at once risked a traffic surge and a reversal of power dips measured in tens of megawatts.",
      tone: "success",
    },
    {
      at: "After 21:28 UTC",
      title: "Services return in stages",
      body: "Meta says storm drills informed the ramp and that services came back without further systemwide failures. It also says it had never simulated losing the global backbone and will look for ways to do so.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "access-path",
      prompt:
        "The backbone is down and both normal and out-of-band access are unavailable. What is the first move?",
      options: [
        {
          id: "send-onsite",
          label: "Send engineers to the data centers and use the physical access procedure.",
          consequence:
            "This is the path Meta describes. It takes time because facilities are secured and hardware is hard to modify, but it does not depend on the failed network.",
          quality: "good",
        },
        {
          id: "wait-remote",
          label: "Wait for remote access to return before changing anything.",
          consequence:
            "Recovery then depends on the same path that failed. Meta says normal and out-of-band access were both down, so waiting provides no independent lever.",
          quality: "poor",
        },
        {
          id: "remote-region",
          label: "Restart the backbone from a remote region that still has connectivity.",
          consequence:
            "Meta's account says the backbone was disconnected globally and the audit tool did not stop the command. A remote region is not described as an available control path.",
          quality: "poor",
        },
      ],
      debrief:
        "The recovery path must not share fate with the failure. Meta's account shows that the usual remote path and the out-of-band path were both gone, leaving physical access. That path worked but was slow because security controls are designed for exactly this kind of physical intervention. The lesson is to design and rehearse an independent path, not to assume one exists because it is labeled out-of-band.",
    },
    {
      id: "restore-ramp",
      prompt: "Backbone connectivity is restored. How should services be brought back?",
      options: [
        {
          id: "staged-ramp",
          label: "Ramp traffic in stages and watch power and load.",
          consequence:
            "Meta says a simultaneous restore could cause a new round of crashes; data centers had reported power dips of tens of megawatts. Staged restoration, informed by storm drills, avoided further systemwide failure.",
          quality: "good",
        },
        {
          id: "restore-all",
          label: "Restore every service at once to shorten the outage.",
          consequence:
            "The report warns that reversing the power dip suddenly could put electrical systems and caches at risk. A faster-looking action adds a second failure mode.",
          quality: "poor",
        },
        {
          id: "stay-offline",
          label: "Keep services offline until the full review is complete.",
          consequence:
            "This avoids the surge but extends impact. Meta restored services and continued the review afterward, separating immediate recovery from the longer learning process.",
          quality: "mixed",
        },
      ],
      debrief:
        "Recovery is a load event. The same system that failed under a sudden loss of connectivity can fail again under a sudden return of traffic and power. A staged ramp gives operators a chance to stop if caches, electrical systems, or dependent services misbehave. Storm drills are valuable because they rehearse that ramp before it is needed.",
    },
    {
      id: "durable-control",
      prompt: "Which control most directly addresses this failure?",
      options: [
        {
          id: "independent-path",
          label: "Make the recovery path independent of the backbone and test losing the backbone.",
          consequence:
            "Meta says both access paths were down and that it had never run a storm simulating global backbone loss. An independent path plus a drill tests the actual dependency.",
          quality: "good",
        },
        {
          id: "fix-audit-only",
          label: "Fix the audit tool and stop there.",
          consequence:
            "The audit bug is a real cause, but the outage persisted because the recovery tools shared the failed network. A single fix leaves the recovery dependency untouched.",
          quality: "mixed",
        },
        {
          id: "more-ads",
          label: "Add more BGP advertisements for the DNS prefixes.",
          consequence:
            "The DNS servers withdrew their own advertisements because they could not reach the data centers. More advertisements do not restore the underlying path or the management plane.",
          quality: "poor",
        },
      ],
      debrief:
        "There are two distinct failures to fix: the command that removed the backbone, and the fact that recovery depended on the backbone. The audit tool belongs to the first. The second needs a path that survives a total backbone loss, plus a drill that proves the path works under the same security constraints as a real event. Testing only the happy path would miss the delay that dominated this outage.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A maintenance command intended to assess backbone capacity removed all backbone connections. The audit tool that should have blocked the command had a bug. DNS servers in edge facilities could not reach the data centers, so they withdrew their BGP advertisements and became unreachable even though they were still running. The result was a global disappearance from the Internet.",
    },
    { type: "h3", text: "Why recovery was hard" },
    {
      type: "list",
      items: [
        "Normal and out-of-band network access both depended on the failed backbone.",
        "DNS loss disabled internal tools used to investigate and resolve the outage.",
        "Physical access was deliberately slow: secured facilities, hard-to-modify hardware, and a secure-access protocol.",
        "Restoring power and traffic at once risked a second failure from a multi-megawatt load step.",
      ],
    },
    { type: "h3", text: "What Meta said it would change" },
    {
      type: "p",
      text: "Meta said it would strengthen testing, drills, and overall resilience, and specifically that it would look for ways to simulate global backbone loss. It described the security tradeoff as deliberate: hardening slowed recovery, but Meta judged the day-to-day security benefit worth it. The post does not publish a complete remediation list, so this file does not invent one.",
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "A network can isolate itself from its own management plane. Redundancy that shares the failed path is not redundancy. The recovery plan must name a path that survives the failure, the people who can use it, and the time it takes to activate; then it must be drilled at the scale of the failure you claim to handle. A controlled ramp is part of recovery, not an afterthought, because restoring demand can be as dangerous as the original outage.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Time notation",
      body: "Relative offsets are derived from Cloudflare's published UTC observations. Meta did not publish exact internal timings; events without a source timestamp are marked as phases, not assigned invented times.",
    },
  ],
  sources: [
    {
      title: "More details about the October 4 outage",
      url: "https://engineering.fb.com/2021/10/05/networking-traffic/outage-details/",
      publisher: "Meta Engineering",
      kind: "postmortem",
      note: "Official account of the backbone command, audit bug, DNS withdrawal, physical recovery, and staged restoration.",
    },
    {
      title: "Update about the October 4th outage",
      url: "https://engineering.fb.com/2021/10/04/networking-traffic/outage/",
      publisher: "Meta Engineering",
      kind: "docs",
      note: "Initial official statement: faulty backbone configuration, cascading effect, no malicious activity.",
    },
    {
      title: "Understanding how Facebook disappeared from the Internet",
      url: "https://blog.cloudflare.com/october-2021-facebook-outage/",
      publisher: "Cloudflare Blog",
      kind: "docs",
      note: "External BGP and DNS observations, including withdrawal and recovery timestamps.",
    },
  ],
};
