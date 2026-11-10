import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "public",
  company: "Fastly",
  date: "June 8, 2021",
  incidentClass: "Latent edge software bug triggered by a valid customer configuration",
  accuracyNote:
    "Verified against Fastly's June 8, 2021 incident summary and the status-page record for the same event. The May 12 software deployment, the 85% error figure, the 09:47-12:44 operational timeline, and the 17:25 fix deployment are as published. The postmortem says the network returned errors and does not name a status code; the 503 in the case title is the project's manifest label, and the cited postmortem does not confirm that status code. Not verified: which customer configuration triggered the bug, the bug's internal mechanism, per-PoP error rates, or the number of affected customers. No telemetry has been invented.",
  timeline: [
    {
      at: "May 12, 2021",
      title: "A software deployment plants the bug",
      body: "Fastly begins deploying software that contains a latent bug. It is triggerable only by a specific customer configuration under specific circumstances, and it stays dormant for almost four weeks.",
      tone: "info",
    },
    {
      at: "09:47 UTC",
      title: "A valid config triggers it",
      body: "A customer pushes a configuration change that meets the trigger conditions. Errors spread across 85% of the network.",
      tone: "danger",
    },
    {
      at: "09:48 UTC",
      title: "Monitoring catches it in a minute",
      body: "Fastly monitoring identifies the global disruption one minute after onset.",
      tone: "warn",
    },
    {
      at: "09:58 UTC",
      title: "Status post published",
      body: "The first public status update goes out eleven minutes after onset.",
      tone: "info",
    },
    {
      at: "10:27 UTC",
      title: "The customer configuration is identified",
      body: "Engineering traces the failure to the specific customer configuration and disables it.",
      tone: "success",
    },
    {
      at: "10:36-11:00 UTC",
      title: "Services recover",
      body: "Impacted services begin to recover at 10:36, and the majority are restored by 11:00. Ninety-five percent of the network is normal within 49 minutes.",
      tone: "success",
    },
    {
      at: "12:35-12:44 UTC",
      title: "Mitigated, then resolved",
      body: "The incident is mitigated at 12:35 and the status post is resolved at 12:44.",
      tone: "success",
    },
    {
      at: "17:25 UTC",
      title: "The permanent fix ships",
      body: "Fastly begins deploying the bug fix after mitigating the customer impact. The postmortem commits to reviewing why QA and testing missed the bug.",
      tone: "info",
    },
  ],
  decisions: [
    {
      id: "deployment-unit",
      prompt:
        "A configuration change is valid and passes validation. What deployment unit do you use at the edge?",
      options: [
        {
          id: "pop-canary",
          label: "Activate on a small set of PoPs and a small traffic share first.",
          consequence:
            "The change meets the production interactions of a few PoPs before the whole network. A latent trigger surfaces as a small incident with a bounded rollback.",
          quality: "good",
        },
        {
          id: "global-valid",
          label: "Activate globally because validation passed.",
          consequence:
            "Validation proves the configuration is well formed, not that it is safe against every latent bug. One customer change reaches 85% of the network at once.",
          quality: "poor",
        },
        {
          id: "customer-staging",
          label: "Require the customer to test in staging before activation.",
          consequence:
            "Staging cannot reproduce every production interaction, and the burden shifts to the customer. The bug was in Fastly's software, not in the customer's intent.",
          quality: "mixed",
        },
      ],
      debrief:
        "The configuration was valid, and Fastly says so. The failure came from an undiscovered software bug that the configuration happened to trigger. Validation answers whether a change is allowed; a canary answers what happens when it meets real traffic. They are different questions.",
    },
    {
      id: "first-mitigation",
      prompt:
        "Most of the network is returning errors and the trigger is unknown. What is the first move?",
      options: [
        {
          id: "disable-config",
          label: "Find and disable the customer configuration that triggered the failure.",
          consequence:
            "Engineering identifies the configuration at 10:27 and disables it; recovery begins at 10:36. The platform stays up while the permanent fix is developed.",
          quality: "good",
        },
        {
          id: "rollback-software",
          label: "Roll back the May 12 software release everywhere.",
          consequence:
            "The bug did enter with that release, but a global software rollback is broader and slower than disabling one configuration. The permanent fix only began deploying at 17:25.",
          quality: "mixed",
        },
        {
          id: "wait-it-out",
          label: "Wait for the triggering configuration to expire or be superseded.",
          consequence:
            "The configuration is valid and stays active. Nothing in the system removes it, so the errors continue indefinitely.",
          quality: "poor",
        },
      ],
      debrief:
        "Disabling the trigger was faster than replacing the software that contained the bug. That is the value of a reversible config control plane: it can remove an input without rebuilding the platform. The permanent fix is a separate, later change with its own rollout.",
    },
    {
      id: "durable-control",
      prompt: "What would keep one valid configuration from taking down most of the network again?",
      options: [
        {
          id: "isolation-canary",
          label:
            "PoP-level canaries, independent validation, and isolation boundaries such as WebAssembly sandboxes.",
          consequence:
            "Blast radius is bounded before activation, and a latent bug is contained to the canary. Fastly's postmortem points to Compute@Edge isolation as the longer-term direction.",
          quality: "good",
        },
        {
          id: "more-tests",
          label: "Add more unit and integration tests before each release.",
          consequence:
            "Tests are necessary, but the bug survived the existing QA process. Tests cannot enumerate every customer configuration and every production interaction.",
          quality: "mixed",
        },
        {
          id: "manual-approval",
          label: "Require manual approval for every customer configuration change.",
          consequence:
            "It shifts the burden to customers and does not scale. A valid change would still trigger the bug, and approval adds latency without adding containment.",
          quality: "poor",
        },
      ],
      debrief:
        "The durable answer is architectural: run untrusted configuration behind an isolation boundary, and activate it on a unit smaller than the fleet. Validation and approval reduce the chance of a bad input; isolation and canaries reduce the cost when a valid input is still wrong.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A software deployment that began on May 12 introduced a latent bug. On June 8, a customer pushed a valid configuration change that met the bug's trigger conditions, and 85% of the network began returning errors. Fastly detected the disruption in one minute, identified the triggering configuration at 10:27, and disabled it. Recovery began at 10:36; 95% of the network was normal within 49 minutes, and the incident was mitigated at 12:35.",
    },
    { type: "h3", text: "Why a valid change was dangerous" },
    {
      type: "list",
      items: [
        "The configuration was valid; the defect was in Fastly's software, deployed almost four weeks earlier.",
        "The trigger required a specific configuration under specific circumstances, so ordinary testing did not exercise it.",
        "The failure reached most of the network at once, so the first signal was a global outage.",
        "The permanent software fix could only begin after the customer impact was mitigated.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "Fastly deployed a permanent bug fix and reviewed why QA and testing did not detect the defect.",
        "The postmortem committed to improving remediation time and to a complete process review.",
        "Fastly pointed to WebAssembly and Compute@Edge isolation as the longer-term resilience direction.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "At the edge, a configuration change is a production deployment with a global default. Validity is necessary but not sufficient: the safe unit is a set of PoPs and a traffic share small enough that a latent interaction is survivable. The rollback path must also be independent of the failing system, because the control plane that activates a change may be the one the change breaks.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Telemetry provenance",
      body: "Times and percentages are from Fastly's incident summary. The status page lists the incident as 09:58-12:41, while the operational timeline starts at 09:47 and closes at 12:44; the two records measure different boundaries. This file adds no per-PoP error rates or customer counts.",
    },
  ],
  sources: [
    {
      title: "Summary of June 8 outage",
      url: "https://www.fastly.com/blog/summary-of-june-8-outage",
      publisher: "Fastly",
      kind: "postmortem",
      note: "Primary postmortem: cause, timeline, impact figures, and follow-up work.",
    },
    {
      title: "Global CDN Disruption",
      url: "https://www.fastlystatus.com/incident/373771",
      publisher: "Fastly Status",
      kind: "postmortem",
      note: "Official status-page record for the same incident, with its own open and close times.",
    },
  ],
};
