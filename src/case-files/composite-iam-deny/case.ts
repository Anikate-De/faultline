import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Broad authorization failure after a shared policy change",
  accuracyNote:
    "This is an original composite, not a real company incident. It is not a real incident and does not describe any organization's architecture, dates, traffic, people, or internal decisions. The sequence is assembled from common IAM failure modes, all times are relative, and all telemetry is illustrative.",
  architecture: { id: "request-path" },
  timeline: [
    {
      at: "T+00:00",
      title: "A shared policy is tightened",
      body: "A routine cleanup adds an explicit deny for a broad action prefix to a permissions boundary used by several teams. The change passes review because it removes permissions that look unused in the sampled window.",
      tone: "info",
    },
    {
      at: "T+00:04",
      title: "The first access denied appears",
      body: "One service cannot read a shared secret. Its error rate moves by a fraction of a percent, and the on-call engineer treats it as an intermittent dependency problem.",
      tone: "warn",
    },
    {
      at: "T+00:15",
      title: "A second wave arrives",
      body: "Long-running batch workers refresh credentials and pick up the new policy. Work queues begin to back up, but the affected services still look unrelated.",
      tone: "warn",
    },
    {
      at: "T+00:28",
      title: "Denials cross service boundaries",
      body: "Services sharing the boundary lose object reads and queue permissions. Callers retry the failures, so request rate climbs while useful throughput falls.",
      tone: "danger",
    },
    {
      at: "T+00:50",
      title: "Incident declared",
      body: "Checkout and reporting both fail. The first responders compare application deploys and find no common release, which is the first signal that the change was not in the application layer.",
      tone: "danger",
    },
    {
      at: "T+01:10",
      title: "Audit logs point at identity",
      body: "Denied events cluster on one action prefix and a small set of principals. A diff of policy versions shows the new explicit deny, which overrides the allows the services still expect.",
      tone: "info",
    },
    {
      at: "T+01:25",
      title: "Rollback is partial",
      body: "Reverting the boundary stops new denials, but existing sessions and cached authorization decisions keep failing. A rolling credential refresh is needed before every service recovers.",
      tone: "warn",
    },
    {
      at: "T+02:20",
      title: "Access and traffic recover",
      body: "Denied events fall to baseline, queues drain, and the incident closes. The cleanup is reworked as a staged change with a tested rollback.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-move",
      prompt: "Half the fleet returns access denied after a shared policy update. What is your first move?",
      options: [
        {
          id: "revert-policy",
          label: "Revert the policy version and reapply it in stages after access recovers.",
          consequence:
            "New denials stop immediately and the fleet can recover. The team keeps the intended cleanup as a reviewed change instead of abandoning it, and the rollback is small because policy versions are immutable.",
          quality: "good",
        },
        {
          id: "scale-services",
          label: "Scale the failing services so more requests succeed.",
          consequence:
            "More replicas produce more denied calls. The failure is authorization, not capacity, so the added load makes queues and retry pressure worse without restoring a single permission.",
          quality: "poor",
        },
        {
          id: "restart-fleet",
          label: "Restart every task to clear cached credentials and decisions.",
          consequence:
            "Some services recover when they obtain fresh sessions, but the deny remains in force. A broad restart adds unavailability and destroys the evidence that would have localized the change.",
          quality: "mixed",
        },
      ],
      debrief:
        "The fastest safe rollback is the policy version, because it is the only artifact that explains failures across unrelated services. Restarting tasks addresses a symptom (stale sessions) and scaling addresses a different problem (capacity). Neither removes the explicit deny. Roll back first, confirm that new denials stop, then handle credential refresh as a second step.",
    },
    {
      id: "localize",
      prompt: "How do you confirm which change caused the denials?",
      options: [
        {
          id: "audit-diff",
          label: "Correlate denied events by action and principal, then diff policy versions around the first failure.",
          consequence:
            "The denied action and principal set form a clear signature, and the policy diff explains why the allow no longer wins. Responders can name the exact change and its scope before touching anything else.",
          quality: "good",
        },
        {
          id: "app-logs",
          label: "Read each service's application log until a common error appears.",
          consequence:
            "The logs show permission errors but not the policy that produced them. With dozens of services this is slow, and similar messages can come from unrelated causes such as expired credentials.",
          quality: "mixed",
        },
        {
          id: "blame-deploy",
          label: "Roll back the most recent application release as the likely cause.",
          consequence:
            "The release is unrelated, so the rollback adds change and may remove a healthy version. Denials continue, and the team loses time re-deploying what it just removed.",
          quality: "poor",
        },
      ],
      debrief:
        "Authorization failures have a useful property: the audit record names the action, principal, and decision. Grouping those fields turns a fleet-wide symptom into a precise signature. Policy versions make the causal diff cheap. Application logs describe the victim, not the change, so they are better used to confirm impact than to locate the cause.",
    },
    {
      id: "lasting-control",
      prompt: "What control should keep the next policy cleanup from becoming an outage?",
      options: [
        {
          id: "staged-policy",
          label: "Stage policy changes by principal group, test with recorded requests, and keep an explicit deny inventory.",
          consequence:
            "Broad denies are visible before they ship, and each group can be rolled out and observed separately. The team retains least privilege without treating every cleanup as a fleet-wide event.",
          quality: "good",
        },
        {
          id: "remove-denies",
          label: "Remove explicit denies and rely on allow lists only.",
          consequence:
            "The immediate conflict disappears, but so does a valuable guardrail. Some denies exist to bound permissions that an allow path would otherwise grant, so this widens access and can create a security regression.",
          quality: "poor",
        },
        {
          id: "manual-review",
          label: "Require a second manual reviewer for every policy change.",
          consequence:
            "Review helps, but the original change already passed review because the unused permissions looked safe in a sample. Manual review alone does not test behavior across principals or catch delayed session effects.",
          quality: "mixed",
        },
      ],
      debrief:
        "The durable fix is behavioral testing plus scope control. Record real authorization requests, evaluate them against the proposed policy, and roll out by principal group. Keep a list of explicit denies with an owner and a reason, because a deny is the one statement that silently overrides every allow. Add a break-glass path so responders can revert a policy version without waiting for the author.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A cleanup added an explicit deny to a permissions boundary shared by many services. The deny was valid for the permissions it targeted but also matched actions that active workloads still used. Because the boundary applied broadly, unrelated services failed together, and long-lived sessions made the impact arrive in waves.",
    },
    { type: "h3", text: "Why it spread" },
    {
      type: "list",
      items: [
        "The change was reviewed against a sample of recent usage, not against the full set of active principals and actions.",
        "An explicit deny overrode allows that other teams depended on, and no inventory showed who was covered by the boundary.",
        "Session and authorization caching delayed the second wave, so the first errors looked like isolated dependency noise.",
        "The rollout had no staged groups and no tested revert, which lengthened the window between cause and recovery.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "Policy changes ship to one principal group at a time with a defined observation window.",
        "Recorded authorization requests are evaluated against the proposed policy before merge.",
        "Explicit denies carry an owner, a reason, and a list of covered principals.",
        "The incident runbook starts with the policy version diff and a break-glass revert.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "Identity configuration is production code with a wider blast radius than most deploys. It deserves the same staging, testing, and rollback discipline, plus one extra check: whether any deny now shadows an allow that a live workload needs. When failures span services with no shared release, look at shared configuration before debugging each service.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, error rates, and audit observations in this file are illustrative. They describe a composite scenario, not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Policy evaluation logic",
      url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html",
      publisher: "AWS Identity and Access Management",
      kind: "docs",
      note: "Explicit deny, allow evaluation order, and permissions boundaries.",
    },
    {
      title: "Testing IAM policies with the IAM policy simulator",
      url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_testing-policies.html",
      publisher: "AWS Identity and Access Management",
      kind: "docs",
      note: "Evaluating policies against recorded or simulated requests.",
    },
    {
      title: "AWS CloudTrail User Guide",
      url: "https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-user-guide.html",
      publisher: "AWS CloudTrail",
      kind: "docs",
      note: "Audit events for authorization decisions and API activity.",
    },
    {
      title: "What is IAM Access Analyzer?",
      url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/what-is-access-analyzer.html",
      publisher: "AWS Identity and Access Management",
      kind: "docs",
      note: "Findings for unintended external and unused access.",
    },
  ],
};
