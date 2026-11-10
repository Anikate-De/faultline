import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Long-lived deployment credential exposed through build logs",
  accuracyNote:
    "This is an original composite scenario, not a real incident. It combines common credential-handling, logging, and build-pipeline failures into one representative security event. It is not a real company incident and does not describe any organization's architecture, credentials, dates, or internal decisions. All times and telemetry are illustrative.",
  timeline: [
    {
      at: "T-30d",
      title: "A pipeline gets a permanent key",
      body: "A deployment step needs to write artifacts to a cloud account. The fastest path is a long-lived access key stored as a pipeline secret. The key inherits a legacy administrative policy because no one scopes it during the migration.",
      tone: "warn",
    },
    {
      at: "T-0 09:10",
      title: "A failed build prints the environment",
      body: "A diagnostic change prints the process environment when an upload fails. The access key and secret appear in the build log, which is retained for ninety days and readable by every engineer in the organization.",
      tone: "danger",
    },
    {
      at: "T-0 09:40",
      title: "The log is copied into a ticket",
      body: "An engineer pastes the failing section into a support ticket. The credential now exists in two systems with different access controls and retention policies.",
      tone: "danger",
    },
    {
      at: "T+2d 08:15",
      title: "An anomaly is detected",
      body: "A threat-detection system flags calls from the key in a network the pipeline never uses. The calls enumerate storage locations and read one object. The alert is routed to a queue that is checked during business hours.",
      tone: "warn",
    },
    {
      at: "T+2d 13:00",
      title: "The key is disabled",
      body: "The on-call engineer confirms the activity, disables the key, and opens a security incident. The exposure window is roughly four days; the confirmed unauthorized activity lasted under an hour.",
      tone: "success",
    },
    {
      at: "T+2d 15:30",
      title: "Blast radius is mapped",
      body: "Audit records show the key's identity, the calls made, and the resources it could reach. The administrative policy means the theoretical blast radius included every bucket in the account, not only the deployment target.",
      tone: "warn",
    },
    {
      at: "T+3d",
      title: "Workload identity replaces the key",
      body: "The pipeline exchanges its platform identity for a short-lived role scoped to one artifact prefix. Log redaction and secret scanning are enabled, and the old key is deleted after rotation is verified.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-response",
      prompt: "A live access key is visible in a build log. What is the first response?",
      options: [
        {
          id: "revoke-first",
          label: "Disable the key, preserve the logs, and start the security incident.",
          consequence:
            "The credential stops working before the investigation begins. Evidence remains available, and the team can determine whether the key was used without racing an active attacker.",
          quality: "good",
        },
        {
          id: "investigate-first",
          label: "Query audit logs first, then revoke once you understand the usage.",
          consequence:
            "The investigation may be more complete, but the key remains valid throughout. An attacker with the same log access can use the delay to expand the blast radius.",
          quality: "mixed",
        },
        {
          id: "purge-logs",
          label: "Delete the build log and ticket to remove the credential from view.",
          consequence:
            "The leak appears contained, but the key is still valid and the evidence needed to scope the incident is gone. Destructive cleanup also complicates disclosure and forensics.",
          quality: "poor",
        },
      ],
      debrief:
        "Containment comes before understanding. Revoking the key is reversible in the sense that a new credential can be issued; leaving it active is not. Preserving the logs matters because they show who could see the secret and whether it was used. Deleting evidence is not containment.",
    },
    {
      id: "blast-radius",
      prompt: "The key is disabled. How do you establish what it could reach and what it did?",
      options: [
        {
          id: "audit-and-permissions",
          label: "Query control-plane audit records for the key identity and review its effective permissions.",
          consequence:
            "The team can distinguish attempted calls from successful ones and compare the key's policy with the resources it actually touched. Remediation is scoped to evidence rather than assumption.",
          quality: "good",
        },
        {
          id: "assume-safe",
          label: "Treat the absence of a second alert as proof that nothing was accessed.",
          consequence:
            "Detection coverage is never complete. The team closes the incident without checking audit records and may miss reads or privilege changes that did not trigger a rule.",
          quality: "poor",
        },
        {
          id: "rotate-only",
          label: "Rotate the key, update the pipeline, and close the incident.",
          consequence:
            "Rotation restores the deployment path but does not answer whether data was accessed. The organization cannot describe impact to customers or auditors.",
          quality: "poor",
        },
      ],
      debrief:
        "Blast radius has two halves: what the credential was allowed to do and what it actually did. Effective permissions come from the policy and any inherited roles; activity comes from audit records. A rotation fixes the future without explaining the past.",
    },
    {
      id: "prevent",
      prompt: "What change removes the class of failure, not just this key?",
      options: [
        {
          id: "workload-identity",
          label:
            "Use short-lived workload identity, scope the role to the artifact path, and redact secrets from logs.",
          consequence:
            "There is no long-lived secret to copy, the role cannot reach unrelated resources, and diagnostic output no longer becomes a distribution channel. The pipeline keeps working without a shared static credential.",
          quality: "good",
        },
        {
          id: "encrypt-secret",
          label: "Encrypt the pipeline secret at rest and restrict who can read the secret store.",
          consequence:
            "Encryption helps the store, but the build process still decrypts the key and can print it. The same leak is possible through logs, crash dumps, or a compromised step.",
          quality: "mixed",
        },
        {
          id: "rotate-more",
          label: "Rotate the static key every thirty days and require a ticket for each rotation.",
          consequence:
            "The exposure window shrinks, but a long-lived credential still exists and the manual process adds failure modes. Rotation does not reduce the permissions that made the key valuable.",
          quality: "poor",
        },
      ],
      debrief:
        "The durable controls are identity, scope, and observability. Workload identity removes the reusable secret; least privilege limits what a leaked identity can do; redaction and scanning keep credentials out of logs. Rotation is a compensating control, not a substitute for any of the three.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "A deployment pipeline used a long-lived access key with administrative permissions. A diagnostic build printed the key into logs that were broadly readable and copied into a ticket. Two days later, threat detection saw the key used from an unfamiliar network. The key was disabled, the activity was scoped through audit records, and the pipeline moved to short-lived workload identity.",
    },
    {
      type: "h3",
      text: "What made it worse",
    },
    {
      type: "list",
      items: [
        "The key had administrative permissions inherited from a legacy policy.",
        "Build logs were readable by every engineer and retained for ninety days.",
        "The diagnostic print was added without a review that considered secret exposure.",
        "The anomaly alert routed to a business-hours queue rather than a security on-call path.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "The pipeline assumes a short-lived role scoped to a single artifact prefix.",
        "Build logs redact environment values and are scanned for credential patterns before storage.",
        "Secret access and deployment-role assumption are logged and reviewed.",
        "Credential-exposure alerts page a security responder, not a general queue.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "A static key in a build system is a password with a job title. It exists in environment variables, logs, artifacts, and crash reports, and every copy is a potential leak. Workload identity removes the reusable secret, least privilege limits the damage when one appears, and log hygiene reduces the number of places it can appear.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, retention periods, and alert timings in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Security best practices in IAM",
      url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Least privilege, credential rotation, and avoiding long-lived access keys.",
    },
    {
      title: "Configuring OpenID Connect in Amazon Web Services",
      url: "https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services",
      publisher: "GitHub",
      kind: "docs",
      note: "Exchanging a CI identity for short-lived cloud credentials.",
    },
    {
      title: "IAM roles for service accounts",
      url: "https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Workload identity and scoped role assumption for workloads.",
    },
  ],
};
