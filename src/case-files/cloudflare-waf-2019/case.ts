import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "public",
  company: "Cloudflare",
  date: "July 2, 2019",
  incidentClass: "Global edge CPU exhaustion from a WAF rule",
  accuracyNote:
    "Verified against Cloudflare's July 2 incident update and its July 12, 2019 detailed postmortem, both cited below. Deployment, detection, termination, and re-enable times are as published. The 27-minute outage, the roughly 80% traffic drop, and the world-wide CPU exhaustion are Cloudflare's figures. Not verified: per-PoP CPU values beyond the published charts, customer-level impact, or the internal review discussion. The offending regular expression is described, not reproduced. No telemetry has been invented; every number here comes from a cited source.",
  timeline: [
    {
      at: "13:31 UTC",
      title: "A rule change is merged",
      body: "An engineer merges a pull request changing XSS detection rules in WAF Managed Rules. The change request carries a deployment plan and a rollback plan.",
      tone: "info",
    },
    {
      at: "13:37 UTC",
      title: "CI passes the wrong test",
      body: "The build and the WAF test suite pass. The suite checks blocking and false positives; it does not measure CPU, and no increase in test runtime was observed.",
      tone: "info",
    },
    {
      at: "13:42 UTC",
      title: "The rule goes global in seconds",
      body: "An automated process deploys it through Quicksilver, the replicated key-value store. Every PoP receives the rule at once, because the SOP for rule changes permits a global push.",
      tone: "warn",
    },
    {
      at: "13:45 UTC",
      title: "The first page, then a flood",
      body: "A synthetic WAF test pages. More end-to-end tests fail, a global traffic-drop alert fires, and PoPs report CPU exhaustion. Visitors see 502 pages.",
      tone: "danger",
    },
    {
      at: "14:00 UTC",
      title: "The WAF is identified",
      body: "Live CPU data and strace output point to the WAF, and an attack is ruled out. At 14:02 the team proposes a global terminate.",
      tone: "warn",
    },
    {
      at: "14:07 UTC",
      title: "A component-level kill switch",
      body: "An engineer executes the global WAF termination. By 14:09 traffic and CPU are back to expected levels, and the other protections keep running. Reaching the switch required bypassing internal tools that sat behind the same failed edge.",
      tone: "success",
    },
    {
      at: "14:52 UTC",
      title: "Re-enable after controlled tests",
      body: "The team runs negative and positive tests in one city on a subset of traffic, with paying customers removed from that location, then re-enables the WAF globally.",
      tone: "success",
    },
    {
      at: "After the incident",
      title: "The remediation list",
      body: "Cloudflare restores the removed CPU protection, inspects all 3,868 rules, adds performance profiling, and schedules a regex engine with run-time guarantees.",
      tone: "info",
    },
  ],
  decisions: [
    {
      id: "rollout-unit",
      prompt:
        "The rule is a routine XSS update in simulate mode and CI is green. How should it reach production?",
      options: [
        {
          id: "global-push",
          label: "Push globally through Quicksilver, as the SOP allows.",
          consequence:
            "The rule reaches every PoP within seconds. When it triggers catastrophic backtracking, all HTTP-serving CPU is consumed and the whole edge fails at once.",
          quality: "poor",
        },
        {
          id: "staged-pops",
          label: "Stage through the DOG, PIG, and Canary PoPs used for software releases.",
          consequence:
            "The rule would run on employee traffic, then a small customer subset, so runaway CPU would surface before global exposure. It costs hours and delays protection.",
          quality: "good",
        },
        {
          id: "hold-rule",
          label: "Hold the rule until the regex engine is replaced.",
          consequence:
            "The CPU risk disappears, but so does protection against the XSS technique the rule targets. A blanket hold treats every rule as equally dangerous.",
          quality: "mixed",
        },
      ],
      debrief:
        "Cloudflare's postmortem says the process was followed correctly: the PR was approved, CI ran, and the change request existed. The missing control was a staged deployment unit for rules, not another approval. Simulate mode was not a safety boundary because the rule still executed on every request.",
    },
    {
      id: "first-mitigation",
      prompt:
        "CPU is at 100% on HTTP-serving cores worldwide and 502s are spreading. What do you do first?",
      options: [
        {
          id: "kill-switch",
          label: "Terminate the WAF globally with the component kill switch.",
          consequence:
            "CPU falls at once and traffic recovers within two minutes. Filtering stops until re-enable, a deliberate and reversible trade that the postmortem records as the actual move.",
          quality: "good",
        },
        {
          id: "rollback-rule",
          label: "Roll back the rule through the normal build pipeline.",
          consequence:
            "It fixes the cause, but the rollback plan required running the complete WAF build twice, so it could not restore service inside the failure window.",
          quality: "mixed",
        },
        {
          id: "add-capacity",
          label: "Add capacity and shift traffic away from the busiest PoPs.",
          consequence:
            "The CPU is consumed by the rule's execution, not by a shortage of machines. More cores are more cores to exhaust, and the decision is delayed.",
          quality: "poor",
        },
      ],
      debrief:
        "The global terminate ran at 14:07 and recovery followed at 14:09. Stopping the failing component beat rebuilding it. The catch is access: the kill switch was reached only after working around Cloudflare Access and other internal services that were themselves behind the downed edge.",
    },
    {
      id: "re-enable",
      prompt: "The WAF is off and CPU is normal. How do you restore filtering?",
      options: [
        {
          id: "immediate-global",
          label: "Re-enable globally as soon as the bad rule is removed.",
          consequence:
            "Removing one rule does not prove the other 3,867 are safe. A second pathological pattern would recreate the outage globally with no staged warning.",
          quality: "poor",
        },
        {
          id: "city-test",
          label:
            "Test negative and positive cases in one city on a traffic subset, then re-enable.",
          consequence:
            "The team confirms both that the rule caused the failure and that the rollback works before exposing all customers. The WAF returns at 14:52, 45 minutes after the kill.",
          quality: "good",
        },
        {
          id: "keep-off",
          label: "Leave the WAF disabled until the engine migration ships.",
          consequence:
            "Recurrence risk falls, but customers lose WAF filtering for weeks. The postmortem instead paired a quick re-enable with full rule inspection and profiling.",
          quality: "mixed",
        },
      ],
      debrief:
        "Recovery is a second change, not the absence of the first. The team used one city and a traffic subset to test in both directions before restoring global filtering. That is a canary for the rollback itself, and it is the step that makes a fast re-enable defensible.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A WAF Managed Rules update contained a regular expression with catastrophic backtracking. The rule was valid, reviewed, and passing tests, but executing it consumed all CPU on the cores that served HTTP and HTTPS. Every Cloudflare PoP was affected within seconds, visitors received 502 pages, and traffic fell by roughly 80%. The WAF was terminated globally at 14:07 and service returned by 14:09; filtering was restored at 14:52 after controlled tests.",
    },
    { type: "h3", text: "Why the process did not catch it" },
    {
      type: "list",
      items: [
        "The regex engine used PCRE-style backtracking and offered no run-time complexity guarantee.",
        "A CPU-exhaustion protection had been removed during an earlier WAF refactor intended to reduce CPU use.",
        "The test suite checked blocking behavior and false positives but did not profile CPU consumption.",
        "The rule-change SOP allowed a non-emergency change to deploy globally without the staged rollout used for software.",
        "The rollback required two complete WAF builds, and the first global traffic alert fired too slowly.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "The CPU protection was restored, and all 3,868 rules were inspected for similar backtracking.",
        "Performance profiling became part of the rule test suite, with an engine migration planned for run-time guarantees.",
        "Rule changes moved to staged rollouts, keeping a separate path for emergency global deployment during an active attack.",
        "Cloudflare added a way to take its dashboard and API off its own edge, and automated status-page updates.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "A configuration change can have the same blast radius as a code deploy and a much shorter review. The useful controls are structural: a deployment unit smaller than the fleet, a resource limit that fails closed, a test that measures the resource the change can exhaust, and a kill switch that does not depend on the system it is killing. Approval alone cannot catch a valid input that is expensive to evaluate.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Telemetry provenance",
      body: "Every time and percentage in this file comes from Cloudflare's published incident reports. No request rates, CPU samples, or customer counts have been added. The sequence is a reconstruction from the postmortem, not independent measurement.",
    },
  ],
  sources: [
    {
      title: "Details of the Cloudflare outage on July 2, 2019",
      url: "https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/",
      publisher: "Cloudflare",
      kind: "postmortem",
      note: "Primary postmortem: timeline, contributing factors, regex behavior, and remediation.",
    },
    {
      title: "Cloudflare outage caused by bad software deploy",
      url: "https://blog.cloudflare.com/cloudflare-outage/",
      publisher: "Cloudflare",
      kind: "postmortem",
      note: "Same-day incident update with the 13:42 start, 14:07 termination, and 82% traffic figure.",
    },
  ],
};
