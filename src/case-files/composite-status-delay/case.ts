import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Delayed customer communication during a visible outage",
  accuracyNote:
    "This is an original composite scenario, not a real incident. It combines common incident-communication, approval, and status-page failure modes into one representative case. It does not describe any company's architecture, dates, traffic, or internal decisions. All times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "Checkout begins to fail",
      body: "A configuration change reduces available capacity, and checkout requests start returning errors. The first support tickets arrive within two minutes.",
      tone: "warn",
    },
    {
      at: "T+00:07",
      title: "Customers notice before the status page",
      body: "Support sees a rising queue and social posts about failed payments. The public status page still shows all systems operational because no one has changed its state.",
      tone: "danger",
    },
    {
      at: "T+00:13",
      title: "An internal incident is declared",
      body: "The on-call declares a major incident and assigns an incident commander. A communications owner is named, but the external update policy requires a confirmed root cause and approval from a second team.",
      tone: "warn",
    },
    {
      at: "T+00:15",
      title: "The approval gate holds the first update",
      body: "The communications owner drafts an update, but the approver is in another timezone and the root cause is still unknown. The draft waits while customers continue to discover the failure on their own.",
      tone: "danger",
    },
    {
      at: "T+00:34",
      title: "Support absorbs the uncertainty",
      body: "Support agents improvise explanations and give different estimates. Wait times rise, and customers begin comparing notes publicly. The lack of an official update becomes its own source of distrust.",
      tone: "danger",
    },
    {
      at: "T+00:41",
      title: "A first update is published",
      body: "The status page finally says the team is investigating checkout errors. It does not state who is affected, what still works, or when the next update will arrive.",
      tone: "warn",
    },
    {
      at: "T+01:09",
      title: "The update becomes useful",
      body: "A second update names the affected checkout path, confirms that saved payment methods are failing, offers a workaround, and commits to an update every thirty minutes.",
      tone: "info",
    },
    {
      at: "T+01:52",
      title: "Service is restored",
      body: "The capacity setting is corrected and checkout recovers. The postmortem identifies communication delay, not the technical fix, as the largest driver of support load and customer complaints.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-update",
      prompt:
        "At T+00:15 the cause is unknown but checkout is visibly failing. What should the first external update say?",
      options: [
        {
          id: "known-impact",
          label:
            "State the known impact, affected scope, what still works, any workaround, and the time of the next update.",
          consequence:
            "Customers can make an informed decision and support gets one consistent message. The update does not claim a cause, so it cannot be wrong about one, and the next-update commitment creates a deadline the team can meet.",
          quality: "good",
        },
        {
          id: "wait-root-cause",
          label: "Wait until the root cause is confirmed so the update is accurate.",
          consequence:
            "Accuracy improves for the eventual explanation, but customers spend the interval without information. Support fills the gap with guesses, and the first official word arrives after the outage is already public.",
          quality: "poor",
        },
        {
          id: "generic-investigating",
          label: "Post a short notice that the team is investigating without naming impact or a next update.",
          consequence:
            "The page is no longer silent, but customers cannot tell whether they are affected or what to do. Support still answers the same questions, and another update is needed immediately.",
          quality: "mixed",
        },
      ],
      debrief:
        "External communication does not require certainty about cause. It requires accuracy about what is known: which function is failing, who is affected, what still works, and when the next update will come. Waiting for a root cause delays the only information customers can act on, while a vague notice shifts the work back to support.",
    },
    {
      id: "communication-model",
      prompt: "What operating model prevents the next delayed update?",
      options: [
        {
          id: "named-cadence",
          label:
            "Name a communications lead, pre-approve impact-first templates, publish on a fixed cadence, and host the status page independently.",
          consequence:
            "Updates start within minutes and continue even when there is no technical progress. The status page remains reachable if the production environment is degraded, and support works from the same text.",
          quality: "good",
        },
        {
          id: "update-on-change",
          label: "Publish only when the technical situation changes materially.",
          consequence:
            "The page stays quiet during long investigations, which customers read as inattention. The next update arrives late, and support cannot distinguish 'no change' from 'no one is working on it'.",
          quality: "poor",
        },
        {
          id: "support-owns-comms",
          label: "Let support answer customers directly and update the page after the incident.",
          consequence:
            "Support becomes the de facto communication channel with inconsistent messages and no public record. Customers who do not contact support see nothing, and the postmortem has no external timeline to review.",
          quality: "mixed",
        },
      ],
      debrief:
        "Communication is an incident function with an owner, a cadence, and pre-approved language. Impact-first templates remove the approval bottleneck without removing accountability. An independent status page matters because the system that publishes updates should not depend on the system that is failing.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "Checkout failed after a capacity setting changed. Customers reported the problem before the status page changed, and the first official update waited for a confirmed root cause and a second approver. By the time useful information was published, support had absorbed the uncertainty and trust had already been damaged.",
    },
    {
      type: "h3",
      text: "What made it worse",
    },
    {
      type: "list",
      items: [
        "The external update policy required root cause, which is rarely known early in an incident.",
        "Approval depended on one person in another timezone rather than a pre-approved template.",
        "The first update omitted affected scope, workaround, and next-update time.",
        "Support had no shared macro, so each agent improvised a different explanation.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "A communications lead is assigned at incident declaration, not after diagnosis.",
        "Impact-first templates are pre-approved, and updates commit to a next-update time.",
        "The status page is hosted outside the production environment and tested during game days.",
        "Support macros are generated from the same update text used on the status page.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "Customers do not wait for an organization to understand its own failure. Silence is interpreted, and support will fill it with guesses. An impact-first update with a known scope, a workaround, and a next-update time is more useful than a later explanation of cause, and a fixed cadence keeps the absence of news from becoming news of its own.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, volumes, and customer observations in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Managing Incidents",
      url: "https://sre.google/sre-book/managing-incidents/",
      publisher: "Google SRE Book",
      kind: "book",
      note: "Incident roles, communication, and public updates.",
    },
    {
      title: "Incident communication",
      url: "https://www.atlassian.com/incident-management/incident-communication",
      publisher: "Atlassian Incident Management",
      kind: "docs",
      note: "Audience, cadence, and templates for incident updates.",
    },
    {
      title: "Status pages",
      url: "https://support.pagerduty.com/docs/status-pages",
      publisher: "PagerDuty Documentation",
      kind: "docs",
      note: "Status page publication, subscriber notifications, and incident states.",
    },
  ],
};
