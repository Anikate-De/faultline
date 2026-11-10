import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Audit evidence retention shorter than the required review window",
  accuracyNote:
    "This is an original composite scenario, not a real incident. It combines common log-retention, evidence, and audit-response failures into one representative compliance event. It is not a real company incident and does not describe any organization's systems, contracts, or audit findings. All periods and volumes are illustrative. This is engineering education, not legal advice.",
  timeline: [
    {
      at: "Month 1",
      title: "Retention follows the storage default",
      body: "A cost review trims administrative audit logs to thirty days in the hot store. The policy is recorded as a storage setting, not as a control with an owner or a legal requirement.",
      tone: "info",
    },
    {
      at: "Month 7",
      title: "An auditor requests six months",
      body: "The review covers administrative activity and configuration changes for the full audit period. The request arrives with a sample list and a deadline, and the team discovers that the older data no longer exists.",
      tone: "warn",
    },
    {
      at: "Month 7, week 1",
      title: "Only thirty days are recoverable",
      body: "The primary log store has a month of events. A secondary analytics pipeline kept some entries for forty-five days, but it sampled heavily and did not include every administrative action.",
      tone: "danger",
    },
    {
      at: "Month 7, week 1",
      title: "The gap is scoped",
      body: "The team can show that the control operated for the last thirty days. For the preceding five months, it can show policy, configuration, and change tickets, but not a complete record of administrative activity.",
      tone: "warn",
    },
    {
      at: "Month 7, week 2",
      title: "The gap is disclosed",
      body: "Rather than reconstruct logs, the team gives the auditor the available evidence, a precise description of the missing window, and the remediation plan. The finding is recorded as an evidence gap, not as proof that the control failed.",
      tone: "info",
    },
    {
      at: "Month 8",
      title: "Retention becomes a control",
      body: "Administrative logs move to an immutable archive with a retention period set to the longest contractual and regulatory requirement. Access is restricted, and deletion requires a reviewed exception.",
      tone: "success",
    },
    {
      at: "Month 9",
      title: "The control is tested with a query",
      body: "The team runs a monthly restore-and-query test against a known event and alerts on ingestion gaps. The policy document is no longer the only evidence that retention works.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "audit-response",
      prompt: "The auditor asks for six months and five months of logs are gone. What do you do?",
      options: [
        {
          id: "disclose-and-scope",
          label: "Disclose the exact gap, provide the available evidence, and explain the remediation.",
          consequence:
            "The auditor can evaluate the control on accurate evidence and record a bounded gap. Credibility is preserved, and the remediation can be verified in the next period.",
          quality: "good",
        },
        {
          id: "screenshots",
          label: "Provide configuration screenshots and ask the auditor to treat them as coverage for the missing period.",
          consequence:
            "Screenshots show the current setting, not that the control operated historically. The auditor may reject the evidence and question the rest of the submission.",
          quality: "mixed",
        },
        {
          id: "recreate",
          label: "Recreate the missing log entries from change tickets and present them as the audit log.",
          consequence:
            "The submission is no longer a system record. Reconstructed evidence misrepresents the control, creates an integrity problem, and can turn an evidence gap into a serious finding.",
          quality: "poor",
        },
      ],
      debrief:
        "An evidence gap is survivable; fabricated evidence is not. The honest response separates what the organization can prove from what it cannot. A precise gap description, available corroborating evidence, and a dated remediation plan give the auditor something verifiable to assess.",
    },
    {
      id: "retention-design",
      prompt: "How should retention be designed after the gap?",
      options: [
        {
          id: "tiered-immutable",
          label:
            "Set retention to the longest obligation, archive immutably, restrict access, and support legal holds.",
          consequence:
            "Evidence survives the review window and cannot be silently altered or deleted. The design costs more than a hot-store default, but it matches the control the organization claims to operate.",
          quality: "good",
        },
        {
          id: "keep-hot",
          label: "Keep every log in the hot store for a year so nothing is ever missed.",
          consequence:
            "Coverage improves, but cost and query performance suffer. Without an archive or integrity control, the data is still deletable by anyone with store access.",
          quality: "mixed",
        },
        {
          id: "ninety-days",
          label: "Extend retention to ninety days, matching the longest internal investigation.",
          consequence:
            "The internal use case is covered, but the external audit window is still missed. Retention was chosen from engineering convenience rather than the obligation.",
          quality: "poor",
        },
      ],
      debrief:
        "Retention must be derived from the longest applicable requirement, then implemented with integrity and access controls. A hot-store extension solves neither cost nor tamper resistance. Tiered storage, immutable archives, legal holds, and reviewed deletion turn retention from a setting into a control.",
    },
    {
      id: "verify-retention",
      prompt: "How do you know retention actually works?",
      options: [
        {
          id: "restore-test",
          label: "Run scheduled restore-and-query tests and alert on ingestion or coverage gaps.",
          consequence:
            "The team verifies that an event from the required window can be found, not just that a policy says it should exist. Gaps are detected before an auditor asks.",
          quality: "good",
        },
        {
          id: "annual-review",
          label: "Review the retention configuration once a year during the audit.",
          consequence:
            "Configuration drift and ingestion failures can persist for months. The review confirms intent but does not demonstrate that the data is present and readable.",
          quality: "mixed",
        },
        {
          id: "trust-vendor",
          label: "Rely on the log vendor's retention guarantee in the contract.",
          consequence:
            "The contract describes the vendor's obligation, not the organization's evidence. Exports, access, and deletion behavior can still fail, and the gap surfaces during the audit.",
          quality: "poor",
        },
      ],
      debrief:
        "A retention policy is a claim; a restore test is evidence. Scheduled queries against known events verify coverage, readability, and timestamps. Ingestion-gap alerts catch the failure before it becomes an audit finding. The test should cover the full obligation window, not only the recent hot data.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "Administrative audit logs were retained for thirty days to control storage cost. When an audit requested six months of activity, five months of primary evidence no longer existed. The team disclosed the gap, provided the available corroborating records, and rebuilt retention as an owned control with an immutable archive and a monthly query test.",
    },
    {
      type: "h3",
      text: "What made it worse",
    },
    {
      type: "list",
      items: [
        "Retention was set by a storage default rather than by a requirement.",
        "The deletion policy had no owner and no link to contractual or regulatory windows.",
        "A secondary pipeline looked like a backup but sampled events and lacked complete coverage.",
        "No one tested whether an event from the required window could still be retrieved.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "Administrative logs are archived immutably for the longest applicable retention period.",
        "Deletion requires a reviewed exception, and legal holds override normal expiry.",
        "A monthly restore-and-query test proves that a known event remains retrievable.",
        "Ingestion coverage is monitored, and gaps page the log-platform owner.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "Retention is a compliance control with a cost and an owner, not a storage setting. The required window comes from obligations, the implementation needs integrity and access control, and the proof comes from retrieval tests. When evidence is missing, the correct response is a precise disclosure and a bounded remediation, not a reconstruction that looks complete.",
    },
    {
      type: "callout",
      tone: "info",
      title: "Engineering education, not legal advice",
      body: "Retention periods and audit responses depend on applicable law, contracts, and the organization's control framework. This scenario teaches engineering practice; consult qualified legal and compliance reviewers for a real program.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All retention periods, request windows, and volumes in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Guide to Computer Security Log Management",
      url: "https://csrc.nist.gov/pubs/sp/800/92/final",
      publisher: "NIST",
      kind: "standard",
      note: "Log management, retention, and evidence handling practices.",
    },
    {
      title: "Security best practices for CloudTrail",
      url: "https://docs.aws.amazon.com/awscloudtrail/latest/userguide/best-practices-security.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Protecting, centralizing, and retaining audit logs.",
    },
    {
      title: "CloudTrail log file integrity validation",
      url: "https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-log-file-validation-intro.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Detecting alteration or deletion of delivered audit records.",
    },
    {
      title: "SOC 2 trust services criteria",
      url: "https://www.aicpa-cima.com/topic/audit-assurance/audit-and-assurance-greater-than-soc-2",
      publisher: "AICPA",
      kind: "standard",
      note: "Control evidence and audit-period expectations.",
    },
  ],
};
