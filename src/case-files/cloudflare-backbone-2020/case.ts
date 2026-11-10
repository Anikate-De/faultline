import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "public",
  company: "Cloudflare",
  date: "July 17, 2020",
  incidentClass: "Backbone BGP route leak from a router policy change",
  accuracyNote:
    "Verified against Cloudflare's July 18, 2020 postmortem, cited below, with BGP concepts checked against Cloudflare's public learning page. The 27-minute outage, the roughly 50% traffic drop, the 19 affected locations, and the configuration diff are as published. Not verified: the internal review of the change, activity between the 20:25 link loss and the 21:12 onset, or whether the maximum-prefix change shipped on July 20 as planned. Cloudflare does not publish per-location traffic volumes for this event. No telemetry has been invented.",
  timeline: [
    {
      at: "20:25 UTC",
      title: "A backbone link drops",
      body: "The private link between Newark and Chicago is lost. Backbone traffic between Atlanta and Washington, DC begins to congest.",
      tone: "warn",
    },
    {
      at: "Before 21:12",
      title: "A congestion fix on the wrong object",
      body: "While working the Newark-Chicago issue, network engineering updates a router in Atlanta to remove some of Atlanta's backbone traffic. The intent is local; the change is one line.",
      tone: "info",
    },
    {
      at: "21:12 UTC",
      title: "Atlanta attracts the backbone",
      body: "Deactivating the prefix-list condition inside the policy term leaves the term matching every route. Atlanta advertises all its BGP routes with local-preference 200, while local compute routes were 100, so traffic across the backbone moves to Atlanta.",
      tone: "danger",
    },
    {
      at: "21:12-21:39 UTC",
      title: "The Atlanta router saturates",
      body: "The router and its compute nodes are overwhelmed. Locations connected to the backbone lose service; locations outside that path keep operating.",
      tone: "danger",
    },
    {
      at: "21:39 UTC",
      title: "Remove Atlanta from the backbone",
      body: "The Atlanta router is disabled and traffic begins flowing normally again. The network is built to keep working without a backbone.",
      tone: "success",
    },
    {
      at: "21:47-22:10 UTC",
      title: "A second-order overload",
      body: "A core data center that processes logs and metrics congests, and some logs are dropped. The edge continues serving traffic throughout.",
      tone: "warn",
    },
    {
      at: "22:10 UTC",
      title: "Full recovery",
      body: "Logs and metrics return. The outage lasted 27 minutes and traffic dropped by about 50% across the network.",
      tone: "success",
    },
    {
      at: "After the incident",
      title: "Protocol guardrails",
      body: "Cloudflare adds a maximum-prefix limit on backbone BGP sessions and changes the local-preference of local server routes.",
      tone: "info",
    },
  ],
  decisions: [
    {
      id: "config-change",
      prompt:
        "Backbone congestion is hurting one path, and you need to remove Atlanta's backbone traffic. Which change do you make?",
      options: [
        {
          id: "deactivate-prefix-list",
          label: "Deactivate the prefix-list condition inside the backbone policy term.",
          consequence:
            "The term stays active and now matches every route. All routes leave Atlanta with local-preference 200, so the backbone follows them into Atlanta and the router saturates.",
          quality: "poor",
        },
        {
          id: "deactivate-term",
          label: "Deactivate the entire policy term.",
          consequence:
            "The term stops contributing routes, which is the intended effect. The postmortem names this as the change that should have been made.",
          quality: "good",
        },
        {
          id: "shutdown-router",
          label: "Shut down the Atlanta router first.",
          consequence:
            "It removes Atlanta from the backbone, but it also removes a healthy PoP and its local service. That is a blunt response to a policy problem.",
          quality: "mixed",
        },
      ],
      debrief:
        "The command was syntactically valid and the intent was narrow. Its meaning was not. Deactivating a condition inside a term leaves the term matching everything; deactivating the term removes it. On a router, the unit you disable is the unit whose scope you must understand.",
    },
    {
      id: "first-mitigation",
      prompt:
        "Atlanta is now receiving traffic from across the backbone and other PoPs are failing. What restores service fastest?",
      options: [
        {
          id: "drop-atlanta",
          label: "Disable the Atlanta router and drop it from the backbone.",
          consequence:
            "Traffic re-converges onto other paths and service returns at 21:39. Local Atlanta traffic is lost, but the rest of the network recovers.",
          quality: "good",
        },
        {
          id: "wait-converge",
          label: "Wait for BGP to reconverge on its own.",
          consequence:
            "The leaked routes stay preferred while the session is up. Nothing in the protocol prefers a different path, so the overload continues.",
          quality: "poor",
        },
        {
          id: "add-capacity",
          label: "Add capacity at Atlanta to absorb the traffic.",
          consequence:
            "The problem is path selection, not absolute capacity. More routers there would still attract every backbone route, and provisioning takes longer than the outage.",
          quality: "poor",
        },
      ],
      debrief:
        "The postmortem's fix was to disable the leaking router, not to make it bigger. That works because the backbone is an optimization: the network can serve traffic without it. The same reasoning is a design requirement, not an accident, and it is what made the fast mitigation safe.",
    },
    {
      id: "lasting-control",
      prompt: "What would have bounded the blast radius before this change?",
      options: [
        {
          id: "prefix-and-pref",
          label:
            "A maximum-prefix limit on backbone sessions and a lower local-preference for local server routes.",
          consequence:
            "The session would have shut down when Atlanta leaked too many prefixes, and local routes would not have outranked remote ones. Cloudflare deployed both changes.",
          quality: "good",
        },
        {
          id: "second-reviewer",
          label: "Require a second reviewer on the one-line change.",
          consequence:
            "Review helps, but the command was valid and its effect depended on BGP semantics. A reviewer who does not trace the resulting advertisement would approve it again.",
          quality: "mixed",
        },
        {
          id: "maintenance-window",
          label: "Do the change in a maintenance window with a rollback script ready.",
          consequence:
            "That improves recovery, not prevention. The leak takes effect as soon as the change commits, and the rollback competes with the same congested control plane.",
          quality: "mixed",
        },
      ],
      debrief:
        "The durable controls are enforced by the protocol, not by the operator: a prefix limit that fails the session closed, and a local-preference policy that prevents one site from outranking another. A change review is still useful, but it cannot be the only thing between a one-line edit and the whole backbone.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A backbone link between Newark and Chicago failed, and congestion appeared between Atlanta and Washington, DC. While responding, an engineer changed an Atlanta router to remove some of Atlanta's backbone traffic. The change deactivated a prefix-list condition instead of the policy term, so the router advertised all its routes with an elevated local-preference. Traffic from across the backbone moved to Atlanta, overwhelmed it, and took 19 locations offline for 27 minutes.",
    },
    { type: "h3", text: "Why one line had global reach" },
    {
      type: "list",
      items: [
        "The policy term still matched after its prefix-list filter was removed, so it accepted every route.",
        "Local-preference is transitive on iBGP sessions, so the higher value propagated to other backbone routers.",
        "Local routes from compute nodes had a lower preference, so remote traffic outranked local traffic.",
        "There was no maximum-prefix limit to shut the leaking session down automatically.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "A maximum-prefix limit was added to backbone BGP sessions; Cloudflare said it would have shut down the Atlanta session.",
        "The local-preference of local server routes was changed so a single site cannot attract other sites' traffic.",
        "The backbone configuration was changed globally to prevent the same failure mode.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "Routing changes are control-plane changes, and their effects are not local to the router you edit. A safe review asks what the new policy matches after the edit, which attributes it propagates, and what limit stops it. Capacity planning assumes paths stay put; when a path leaks, the overloaded node is a symptom, not the cause. Design the network to run without its optimizations, then use protocol limits to enforce that assumption.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Telemetry provenance",
      body: "Times, the affected-location list, and the 50% traffic figure are from Cloudflare's postmortem. The file adds no per-PoP request rates, CPU values, or BGP message counts. The differential diagnosis in the decisions is reasoning about the published mechanism, not recovered internal telemetry.",
    },
  ],
  sources: [
    {
      title: "Cloudflare outage on July 17, 2020",
      url: "https://blog.cloudflare.com/cloudflare-outage-on-july-17-2020/",
      publisher: "Cloudflare",
      kind: "postmortem",
      note: "Primary postmortem: timeline, configuration diff, affected locations, and remediation.",
    },
    {
      title: "What Is BGP?",
      url: "https://www.cloudflare.com/learning/security/glossary/what-is-bgp/",
      publisher: "Cloudflare Learning",
      kind: "docs",
      note: "Background on BGP attributes, including local preference and path selection.",
    },
  ],
};
