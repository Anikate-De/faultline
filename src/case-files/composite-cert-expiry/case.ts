import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Expired workload certificate breaking service-to-service TLS",
  accuracyNote:
    "This is an original composite, not a real company incident. It is not a real incident and does not describe any organization's architecture, dates, traffic, people, or internal decisions. It combines common certificate lifecycle failure modes; all times are relative and all telemetry is illustrative.",
  architecture: { id: "request-path" },
  timeline: [
    {
      at: "T-90d",
      title: "A short-lived leaf is issued",
      body: "An internal certificate authority issues a 90-day certificate to a workload identity. Renewal is expected at 60 days, well before expiry, and is treated as an automated platform concern.",
      tone: "info",
    },
    {
      at: "T-30d",
      title: "Renewal starts failing quietly",
      body: "The renewal job lost permission to update a DNS challenge record after an unrelated cleanup. It retries, logs a warning, and exits without paging anyone.",
      tone: "warn",
    },
    {
      at: "T-7d",
      title: "The expiry notice goes nowhere",
      body: "A daily digest is sent to a team alias that was retired months earlier. The certificate has no owner field and no paging route, so the reminder is delivered to an address nobody reads.",
      tone: "warn",
    },
    {
      at: "T+00:00",
      title: "Midnight handshakes fail",
      body: "The certificate expires. New connections between services fail the TLS handshake, while existing connections continue briefly and hide the scope of the failure.",
      tone: "danger",
    },
    {
      at: "T+00:06",
      title: "Retries raise the noise",
      body: "Callers retry handshake failures and circuit breakers open. Error rates rise across several services, but the mesh control plane reports healthy configuration, so the first hypothesis is a routing change.",
      tone: "danger",
    },
    {
      at: "T+00:20",
      title: "Responders inspect the wrong layer",
      body: "DNS and the load balancer are both healthy. A direct handshake check against the service port returns a certificate validity error, which finally points at identity rather than routing.",
      tone: "info",
    },
    {
      at: "T+00:45",
      title: "Emergency re-issue",
      body: "The team issues a replacement from an alternate issuer path that still has permissions, distributes it as a workload secret, and rolls pods so new connections load it.",
      tone: "warn",
    },
    {
      at: "T+01:30",
      title: "Handshakes recover",
      body: "New connections succeed as pods pick up the replacement. Residual queues drain, and the renewal pipeline is repaired with a permission test before the next cycle.",
      tone: "success",
    },
    {
      at: "T+03:00",
      title: "Incident closed",
      body: "The review finds no single dramatic mistake, only a chain of controls that each failed quietly: permissions, ownership, notification, and monitoring.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-diagnostic",
      prompt: "Handshakes fail at midnight and the mesh control plane looks healthy. What do you check first?",
      options: [
        {
          id: "inspect-chain",
          label: "Inspect the certificate chain and validity on the failing listener.",
          consequence:
            "The expired leaf is confirmed in seconds. The team stops investigating routing and starts working on issuance and distribution, which is the actual failing subsystem.",
          quality: "good",
        },
        {
          id: "restart-proxies",
          label: "Restart the proxies to clear their TLS state.",
          consequence:
            "Restarts drop working connections and add unavailability. An expired certificate remains expired, so the handshake failures return as soon as traffic resumes.",
          quality: "mixed",
        },
        {
          id: "scale",
          label: "Scale the affected services to replace unhealthy instances.",
          consequence:
            "New instances load the same expired secret. Capacity increases while every new connection still fails, and the intervention adds load to an already degraded path.",
          quality: "poor",
        },
      ],
      debrief:
        "A validity error is one of the few TLS failures that names its own cause. Checking the presented chain is faster than reasoning about mesh configuration and avoids restarting healthy components. The control plane can be perfectly correct while the data plane has an invalid identity.",
    },
    {
      id: "emergency-fix",
      prompt: "The leaf is expired and renewal is broken. How do you restore service?",
      options: [
        {
          id: "reissue",
          label: "Re-issue from a working issuer path and roll the secret in stages.",
          consequence:
            "New connections recover as pods load the replacement. The staged roll limits the blast radius, and the broken renewal path can be repaired without rushing a permanent fix into production.",
          quality: "good",
        },
        {
          id: "disable-mtls",
          label: "Disable mutual TLS across the mesh to restore plaintext traffic.",
          consequence:
            "Connections may recover quickly, but authentication disappears for every service, not just the failing one. This can be a last resort with explicit approval, not a first response to one expired identity.",
          quality: "mixed",
        },
        {
          id: "wait-renewal",
          label: "Repair the renewal job and wait for the next automated cycle.",
          consequence:
            "The outage continues while the pipeline runs. Automated renewal may also need a full issuance cycle and a rollout, so waiting adds time without reducing the work.",
          quality: "poor",
        },
      ],
      debrief:
        "Emergency response should restore the smallest identity that is broken. Re-issuing and rolling the secret preserves authentication and limits the change to the affected workload. Disabling mTLS converts an availability incident into a security incident and widens the blast radius; it is defensible only as an approved last resort when the alternative is total loss of a critical service.",
    },
    {
      id: "lasting-control",
      prompt: "Which set of controls would have prevented the midnight expiry?",
      options: [
        {
          id: "inventory-renewal",
          label: "Inventory every certificate with an owner, alert on renewal failure, and page on expiry thresholds.",
          consequence:
            "The failed renewal would have paged at T-30d, and the owner would have had a month to repair permissions. Expiry stops being a surprise and becomes a tracked, owned lifecycle.",
          quality: "good",
        },
        {
          id: "longer-certs",
          label: "Issue longer-lived certificates so renewal happens less often.",
          consequence:
            "The interval between failures grows, but the failure mode is unchanged and the eventual expiry is still unmonitored. Longer lifetimes also increase exposure if a key is compromised.",
          quality: "mixed",
        },
        {
          id: "calendar",
          label: "Add a calendar reminder for the platform team.",
          consequence:
            "The reminder depends on a person and an address that may change. It duplicates the notification path that already failed and provides no signal when renewal itself breaks.",
          quality: "poor",
        },
      ],
      debrief:
        "Prevention has three independent parts: know what exists and who owns it, verify that renewal succeeds rather than assuming it will, and page on remaining lifetime before expiry. A calendar entry is a single human dependency; a renewal-failure alert is a control. Test the whole path by rotating a certificate before it is due.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A 90-day workload certificate failed to renew because the renewal job had lost a DNS permission. The failure was logged but not alerted, and the expiry notice went to a retired alias. At expiry, new service-to-service connections failed their TLS handshakes while established connections briefly masked the scope.",
    },
    { type: "h3", text: "Why it was predictable" },
    {
      type: "list",
      items: [
        "Renewal success was assumed, not verified; the job's warning was not a monitored condition.",
        "The certificate had no owner and no paging route, only an email digest to a dead alias.",
        "The emergency path depended on finding an alternate issuer during the outage.",
        "No drill had exercised expiry or rotation, so the first real test was production.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "Every certificate is inventoried with an owner, issuer, and expiry timestamp.",
        "Renewal failures page the owning team, and expiry thresholds page at 30, 14, 7, and 1 days.",
        "A rotation drill runs each quarter and includes a forced renewal failure.",
        "The alternate issuer path is documented and tested before it is needed.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "Certificate expiry is a scheduled outage with a known timestamp. The only question is whether the organization has a control that acts before the clock runs out. Inventory, verified renewal, and paging on remaining lifetime are separate controls; losing any one of them turns a routine rotation into a midnight page that may never arrive.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, durations, and observations in this file are illustrative. They describe a composite scenario, not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "RFC 5280: Internet X.509 Public Key Infrastructure Certificate",
      url: "https://www.rfc-editor.org/rfc/rfc5280",
      publisher: "IETF",
      kind: "standard",
      note: "Certificate validity periods and path validation.",
    },
    {
      title: "RFC 8446: The Transport Layer Security Protocol Version 1.3",
      url: "https://www.rfc-editor.org/rfc/rfc8446",
      publisher: "IETF",
      kind: "standard",
      note: "Handshake behavior and certificate authentication.",
    },
    {
      title: "Certificate resources",
      url: "https://cert-manager.io/docs/usage/certificate/",
      publisher: "cert-manager",
      kind: "docs",
      note: "Certificate requests, renewal, and readiness conditions.",
    },
    {
      title: "Certificate management in Istio",
      url: "https://istio.io/latest/docs/tasks/security/cert-management/",
      publisher: "Istio",
      kind: "docs",
      note: "Workload certificate issuance and rotation in a service mesh.",
    },
    {
      title: "Managed certificate renewal",
      url: "https://docs.aws.amazon.com/acm/latest/userguide/managed-renewal.html",
      publisher: "AWS Certificate Manager",
      kind: "docs",
      note: "Automated renewal behavior and its dependencies.",
    },
  ],
};
