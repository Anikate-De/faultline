import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "public",
  company: "Cloudflare",
  date: "June 21, 2022",
  incidentClass: "BGP policy reorder that withdrew site-local prefixes",
  accuracyNote:
    "Verified against Cloudflare's June 21, 2022 postmortem, cited below. The timestamps, the 19 MCP locations, the 4%-of-network versus 50%-of-requests ratio, and the policy diff are as published. The case title and manifest frame the event as a regional long tail; in reality 19 locations across several regions were affected, not one region. Not verified: per-location request loss, the precise sequence of competing reverts, or the internal review of the change. No telemetry has been invented.",
  timeline: [
    {
      at: "03:56 UTC",
      title: "First location, older architecture",
      body: "The BGP community change is deployed to one location. It runs on the older architecture, so no MCP location is affected.",
      tone: "info",
    },
    {
      at: "06:17 UTC",
      title: "Busiest locations, still not MCP",
      body: "The change reaches high-traffic locations that do not yet use the MCP spine design. There is still no impact.",
      tone: "info",
    },
    {
      at: "06:27 UTC",
      title: "The rollout reaches the spines",
      body: "The change lands on MCP-enabled locations. Reordered policy terms put the site-local advertisement terms behind REJECT-THE-REST, so a critical subset of prefixes is withdrawn.",
      tone: "danger",
    },
    {
      at: "06:27-06:32 UTC",
      title: "Nineteen locations go offline",
      body: "The withdrawal removes direct access to the affected locations and their path to origins. Multimog can no longer balance across compute clusters, so smaller clusters receive more traffic than they can serve.",
      tone: "danger",
    },
    {
      at: "06:32 UTC",
      title: "Incident declared",
      body: "Cloudflare declares an internal incident. Global traffic drops even though the affected locations are only 4% of the network.",
      tone: "warn",
    },
    {
      at: "06:51-06:58 UTC",
      title: "Root cause confirmed",
      body: "A change on one router verifies the cause. By 06:58 the reorder is understood, the first data center is back online, and reverts begin.",
      tone: "success",
    },
    {
      at: "07:42 UTC",
      title: "Reverts collide",
      body: "Engineers revert each other's changes and the problem reappears sporadically. The last revert completes at 07:42, when all 19 data centers are online.",
      tone: "warn",
    },
    {
      at: "08:00 UTC",
      title: "Incident closed",
      body: "Cloudflare commits to MCP-specific stagger steps, a policy redesign, and an automated commit-confirm rollback.",
      tone: "info",
    },
  ],
  decisions: [
    {
      id: "stagger-design",
      prompt:
        "You are rolling a BGP policy change to an architecture used by your busiest locations. How do you sequence it?",
      options: [
        {
          id: "mcp-first",
          label: "Include one MCP location in the first step, then expand.",
          consequence:
            "The change meets the new architecture while the blast radius is one location. A term-ordering error surfaces there instead of on all 19 spines at once.",
          quality: "good",
        },
        {
          id: "existing-stagger",
          label: "Follow the existing stagger: non-MCP locations first, all MCP at the final step.",
          consequence:
            "Every earlier step passes, because none of them exercises the MCP spines. The final step reaches all 19 at once, which is exactly what happened.",
          quality: "poor",
        },
        {
          id: "global-after-review",
          label: "Push globally after peer review and a dry run.",
          consequence:
            "Review and dry runs test the change, not the interaction between the change and every location's policy state. There is no smaller unit if the result is wrong.",
          quality: "poor",
        },
      ],
      debrief:
        "The postmortem's own finding is that the steps were not small enough. A stagger that never touches the target architecture is not a canary for that architecture. The first MCP location should be the first risky step, not the last one.",
    },
    {
      id: "find-subset",
      prompt:
        "Global request success is falling, but the aggregate does not say where. What do you look at?",
      options: [
        {
          id: "per-pop-prefix",
          label: "Per-PoP request success, prefix advertisement state, and per-cluster load.",
          consequence:
            "The affected 19 locations stand out, the withdrawn prefixes are visible in the control plane, and the Multimog imbalance explains why small clusters fail. Each view answers a different part of the question.",
          quality: "good",
        },
        {
          id: "global-only",
          label: "The global success rate and error-budget burn.",
          consequence:
            "They confirm a large outage but cannot distinguish 19 busy locations from a smaller, wider failure. The response stays broad and slow.",
          quality: "poor",
        },
        {
          id: "tickets",
          label: "Customer support tickets grouped by country.",
          consequence:
            "Tickets arrive after users give up and mix real impact with unrelated reports. They can suggest a region but cannot confirm which prefixes stopped being advertised.",
          quality: "mixed",
        },
      ],
      debrief:
        "The aggregate was not healthy, but it was not diagnostic. Nineteen locations were 4% of the network and 50% of requests, so global volume collapsed without telling operators which locations or prefixes were gone. Per-location and control-plane views are what turn a global symptom into a bounded cause.",
    },
    {
      id: "revert-coordination",
      prompt:
        "Several engineers are reverting the change and the failure keeps reappearing. How do you run the recovery?",
      options: [
        {
          id: "serialized",
          label: "Assign one change owner, serialize reverts, and use commit-confirm on each.",
          consequence:
            "Each revert is observed before the next begins, so a reverted revert cannot silently restore the fault. Recovery is slower per step but has one source of truth.",
          quality: "good",
        },
        {
          id: "parallel-reverts",
          label: "Let every engineer revert their own location in parallel.",
          consequence:
            "Concurrent changes overwrite each other and the problem reappears sporadically. The postmortem records exactly this delay before all reverts completed at 07:42.",
          quality: "poor",
        },
        {
          id: "full-rollback",
          label: "Roll the entire network configuration back to the previous commit.",
          consequence:
            "It may remove the bad change, but it also discards unrelated configuration and is hard to verify while the control plane is degraded.",
          quality: "mixed",
        },
      ],
      debrief:
        "Recovery is a change window too. The postmortem describes engineers walking over each other's changes, reverting previous reverts and making the problem reappear. A single owner plus commit-confirm converts parallel improvisation into a sequence that can be observed and stopped.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "Cloudflare was standardizing BGP communities on the site-local prefixes used inside its Multi-Colo PoP architecture. On the spines, two site-local advertisement terms moved from the top of a policy statement to the bottom, behind an explicit reject term. The prefixes were withdrawn, removing direct access to 19 locations and their path to origins. Internal load balancing lost its view of the clusters, small clusters overloaded, and 50% of global requests were affected.",
    },
    { type: "h3", text: "Why the stagger missed it" },
    {
      type: "list",
      items: [
        "The first deployment at 03:56 went to a location on the older architecture.",
        "The 06:17 step covered busy locations that were also not MCP-enabled.",
        "All MCP locations were reached in the final step at 06:27, so no MCP location acted as a canary.",
        "The policy diff was reviewed, but the exclamation-mark reordering was easy to read as a no-op.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "Change procedures and automation were to include MCP-specific test and deploy steps.",
        "The policy statement was to be redesigned so an unintentional ordering cannot withdraw the prefixes.",
        "Cloudflare planned an automated commit-confirm rollback and a stricter stagger policy for network configuration.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "A global policy is a set of ordered rules, and order is behavior. The blast radius of a reorder is every prefix the statement controls, even if the diff looks like metadata. A rollout should exercise the architecture that carries the traffic, not just an older one that happens to be first. And when recovery requires several people editing the same control plane, serialize it: parallel good intentions can recreate the failure.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Telemetry provenance",
      body: "The timestamps, location count, and 50% request figure are from Cloudflare's postmortem. This file adds no per-PoP error rates, prefix counts, or traffic samples. The diagnosis in the decisions follows the published mechanism rather than recovered internal data.",
    },
  ],
  sources: [
    {
      title: "Cloudflare outage on June 21, 2022",
      url: "https://blog.cloudflare.com/cloudflare-outage-on-june-21-2022/",
      publisher: "Cloudflare",
      kind: "postmortem",
      note: "Primary postmortem: timeline, policy diff, MCP background, and follow-up work.",
    },
    {
      title: "What Is BGP?",
      url: "https://www.cloudflare.com/learning/security/glossary/what-is-bgp/",
      publisher: "Cloudflare Learning",
      kind: "docs",
      note: "Background on BGP attributes, policy, and route advertisement.",
    },
  ],
};
