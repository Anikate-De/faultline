import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "BGP backup path not selected during primary data-plane failure",
  accuracyNote:
    "This is an original composite scenario and not a real incident. It combines common BGP best-path, local-preference, session-liveness, and failover-testing failure modes into one representative case. It does not describe any company's architecture, traffic, dates, or internal decisions. All times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "The primary path starts losing packets",
      body: "Monitoring shows 40% packet loss to a critical external service. The primary circuit's interface remains up, and the eBGP session to the provider is still Established.",
      tone: "warn",
    },
    {
      at: "T+00:03",
      title: "The backup is present but not best",
      body: "The router has two default routes. The primary has local preference 200; the backup has local preference 100. Both are valid, but only the primary is installed in the forwarding table.",
      tone: "info",
    },
    {
      at: "T+00:08",
      title: "The control plane hides the failure",
      body: "Because the session never goes down, BGP has no reason to withdraw the primary route. The backup stays idle while traffic is forwarded into a path that is not delivering packets.",
      tone: "danger",
    },
    {
      at: "T+00:15",
      title: "The circuit is confirmed down",
      body: "The provider reports an access-circuit failure. A media converter kept the local interface physically up, so neither the link state nor the BGP session reflected the loss of forwarding.",
      tone: "danger",
    },
    {
      at: "T+00:25",
      title: "A controlled failover restores service",
      body: "On-call administratively shuts the primary BGP neighbor. The primary route is withdrawn, the backup becomes best, and traffic recovers within seconds. The backup path had been usable the whole time.",
      tone: "success",
    },
    {
      at: "T+01:00",
      title: "Liveness is added below BGP",
      body: "BFD is enabled on both eBGP sessions with a short interval and multiplier. A forwarding failure now tears down the session instead of waiting for a hold timer that may never expire.",
      tone: "success",
    },
    {
      at: "T+2 days",
      title: "The drill attacks the data plane",
      body: "A maintenance test blocks forwarding while leaving the interface up. BFD detects the loss, the backup is selected, and the team verifies real application traffic rather than only the routing table.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "why-idle",
      prompt:
        "Both BGP sessions are Established, the backup route is present, but the primary path is blackholing traffic. What is the first thing to establish?",
      options: [
        {
          id: "state-vs-forwarding",
          label:
            "Check best-path attributes and confirm whether the failure is visible to BGP at all, then fail over deliberately.",
          consequence:
            "The team sees local preference keeping the backup out of the forwarding table and recognizes that the session is up despite a data-plane failure. A controlled shutdown restores service without waiting for a timer.",
          quality: "good",
        },
        {
          id: "wait-hold",
          label: "Wait for the BGP hold timer to expire and withdraw the primary route.",
          consequence:
            "The session is still up, so the timer may never expire. Traffic keeps dropping while the team waits for an event that the control plane has no reason to produce.",
          quality: "poor",
        },
        {
          id: "raise-backup-pref",
          label: "Raise the backup's local preference above the primary immediately.",
          consequence:
            "Traffic may move to the backup, but the change is global and persistent. It can overload the backup, create flapping if both paths look healthy, and leaves the original detection gap unexplained.",
          quality: "mixed",
        },
      ],
      debrief:
        "BGP selects paths from control-plane information. Local preference is compared before AS path length, and a higher value wins inside the local AS. A valid but less-preferred backup will stay out of the forwarding table until the primary is withdrawn or the attributes change. The critical distinction is whether the failure affects the session or only the forwarding path. A session that stays up can hide a blackhole indefinitely.",
    },
    {
      id: "controlled-failover",
      prompt:
        "The primary circuit is confirmed unusable but its session remains up. How do you restore service now?",
      options: [
        {
          id: "shut-neighbor",
          label: "Administratively shut the primary BGP neighbor, verify the backup is selected, and confirm application traffic.",
          consequence:
            "The primary route is withdrawn cleanly, the backup becomes best, and the change is reversible. The team can keep the primary down until the provider repairs the circuit.",
          quality: "good",
        },
        {
          id: "reboot-router",
          label: "Reboot the edge router to force a fresh BGP decision.",
          consequence:
            "The reboot disrupts every path on the device, including the backup, and may take longer than the outage. It also destroys the evidence needed to understand why the session stayed up.",
          quality: "poor",
        },
        {
          id: "remove-backup",
          label: "Remove the backup route and rely on the provider to restore the primary.",
          consequence:
            "The only alternate path is discarded during an outage. Recovery now depends entirely on the provider, and the backup cannot be validated under real traffic.",
          quality: "poor",
        },
      ],
      debrief:
        "A controlled shutdown is a deliberate withdrawal: it changes the control-plane input, lets BGP select the backup, and is easy to reverse. The verification must include the forwarding table and a real request, not just the neighbor state. Reboots and route removals add risk and remove evidence. Once service is stable, the underlying liveness gap still needs a durable fix.",
    },
    {
      id: "lasting-liveness",
      prompt:
        "What should make the backup activate when the primary stops forwarding but its interface and session stay up?",
      options: [
        {
          id: "bfd-and-drills",
          label:
            "Run BFD on the sessions, add health tracking for failures beyond the peer, and drill data-plane failover regularly.",
          consequence:
            "Forwarding failures below BGP tear down the session quickly, while periodic drills prove the backup carries real traffic. The team learns the limits of each health signal before an outage.",
          quality: "good",
        },
        {
          id: "hold-timer",
          label: "Tune the BGP hold timer down and rely on session expiry.",
          consequence:
            "Faster timers reduce detection time only when the session actually fails. They do nothing for a blackhole that leaves the session Established, and aggressive timers can cause false failovers.",
          quality: "poor",
        },
        {
          id: "active-active",
          label: "Make both paths active and let ECMP spread traffic.",
          consequence:
            "The backup carries traffic immediately, but the design now depends on both paths being healthy and sized for the combined load. A silent primary failure still sends half the traffic into a blackhole.",
          quality: "mixed",
        },
      ],
      debrief:
        "BFD detects forwarding failure on the segment between BGP peers, which covers access-circuit failures that leave an interface up. It does not cover every failure beyond the peer, so end-to-end health tracking or route injection may still be needed. No single timer replaces a drill: the test should blackhole traffic while the control plane stays up and verify that the backup is selected and usable. Local preference remains the planned preference control; liveness decides when that preference is no longer relevant.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "The primary access circuit stopped forwarding packets, but a media converter kept the interface up and the eBGP session Established. The backup route was valid but less preferred because of a lower local preference. With no withdrawal and no data-plane health check, BGP kept the primary in the forwarding table and the backup stayed idle. A manual neighbor shutdown forced the expected failover.",
    },
    { type: "h3", text: "What made it worse" },
    {
      type: "list",
      items: [
        "Failover depended on BGP session loss, but the failure was invisible to the session.",
        "The backup had never been tested with real application traffic.",
        "Local preference was documented as a number but not as an operational failover control.",
        "Monitoring watched interface state and neighbor state, not end-to-end forwarding.",
        "The provider's circuit failure and the local link state disagreed, and no one owned that gap.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "BFD runs on both eBGP sessions with a detection interval matched to the service's tolerance.",
        "Health tracking covers failures beyond the BGP peer where BFD cannot see them.",
        "Runbooks document how to perform a controlled withdrawal and how to verify the backup.",
        "Quarterly drills blackhole the primary data plane while leaving the control plane up.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "An advertised route is a candidate, not a selected path. BGP prefers routes by attributes such as local preference and AS path length, and it reacts to session changes rather than to application success. A backup can be configured correctly and still never carry traffic. Test failover by breaking forwarding, not just by shutting a session, and verify the result with the workload that depends on it.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, attributes, and packet-loss values in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "RFC 4271: A Border Gateway Protocol 4 (BGP-4)",
      url: "https://www.rfc-editor.org/rfc/rfc4271.html",
      publisher: "IETF",
      kind: "standard",
      note: "BGP session behavior, path attributes, and decision process.",
    },
    {
      title: "RFC 5880: Bidirectional Forwarding Detection",
      url: "https://www.rfc-editor.org/rfc/rfc5880.html",
      publisher: "IETF",
      kind: "standard",
      note: "Forwarding-plane liveness detection.",
    },
    {
      title: "BGP Best Path Selection Algorithm",
      url: "https://www.cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/13753-25.html",
      publisher: "Cisco",
      kind: "docs",
      note: "Attribute order, including local preference and AS path.",
    },
    {
      title: "Routing policies and BGP communities",
      url: "https://docs.aws.amazon.com/directconnect/latest/UserGuide/routing-and-bgp.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "BGP attributes and failover behavior on dedicated connections.",
    },
  ],
};
