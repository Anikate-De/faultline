import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Asymmetric routing through a transit gateway inspection VPC",
  accuracyNote:
    "This is an original composite scenario and not a real incident. It combines common transit gateway route-table, route-propagation, and stateful-inspection failure modes into one representative case. It does not describe any company's architecture, traffic, dates, or internal decisions. All times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "A new spoke is attached",
      body: "A migration adds a spoke VPC to the hub and associates its attachment with the shared spoke route table. The attachment is also allowed to propagate its prefix into that table, a default inherited from the landing-zone module.",
      tone: "info",
    },
    {
      at: "T+00:10",
      title: "Connections time out",
      body: "An application in an existing spoke opens a TCP connection to the new spoke. The SYN reaches the destination, but the connection never completes. Health checks fail and the service is marked unreachable.",
      tone: "warn",
    },
    {
      at: "T+00:40",
      title: "The forward path bypasses inspection",
      body: "The spoke route table contains a static summary route for all spoke address space pointing at the inspection attachment, but the new spoke's propagated /16 is more specific. Existing spokes therefore send traffic directly to the new attachment.",
      tone: "warn",
    },
    {
      at: "T+01:05",
      title: "The return path uses inspection",
      body: "Traffic from the new spoke matches the summary route and enters the inspection VPC. The stateful firewall has never seen the opening SYN, so it treats the SYN-ACK as out of state and drops it.",
      tone: "danger",
    },
    {
      at: "T+01:30",
      title: "The route table looks healthy",
      body: "Every prefix has a next hop and no route is blackholed. The failure is not missing reachability but a difference between the path taken in each direction. The firewall log shows the same flow arriving from the wrong side.",
      tone: "danger",
    },
    {
      at: "T+02:20",
      title: "Propagation is removed",
      body: "The team disables propagation from the new attachment into the spoke table and adds an explicit static route for the new prefix via the inspection attachment. Both directions now traverse the same firewall, and connections recover.",
      tone: "success",
    },
    {
      at: "T+1 day",
      title: "Symmetry is tested, not assumed",
      body: "The landing-zone pipeline adds route-table assertions and a two-direction path probe. Appliance mode is enabled on the inspection attachment so flows remain pinned to one availability zone.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "diagnose-path",
      prompt:
        "The new spoke appears reachable from the inspection VPC, but TCP connections from existing spokes time out. Where do you look first?",
      options: [
        {
          id: "both-directions",
          label:
            "Trace the route lookup for both directions at the source and return attachments, then compare with firewall flow state.",
          consequence:
            "The forward path is found to use a more-specific direct route while the return path uses inspection. The firewall is behaving correctly for a flow it never saw open.",
          quality: "good",
        },
        {
          id: "restart-firewall",
          label: "Restart the inspection firewall and clear its flow table.",
          consequence:
            "The flow table is rebuilt, but the routing asymmetry remains. New connections fail the same way, and the restart adds an outage to the investigation.",
          quality: "poor",
        },
        {
          id: "add-route",
          label: "Add a more-specific static route to the new spoke and retest.",
          consequence:
            "The forward path becomes deterministic, but the return path is not examined. The change may preserve the bypass or create a different mismatch, and the test only proves one direction.",
          quality: "mixed",
        },
      ],
      debrief:
        "Transit gateway routing is directional. An attachment's association selects the table used for traffic entering from that attachment; propagation and static routes populate tables. Reachability in one direction says nothing about the other. A stateful device only permits a flow it observed in both directions, so the diagnostic question is not which route exists but which route each direction actually selects.",
    },
    {
      id: "immediate-fix",
      prompt:
        "The new spoke's propagated /16 is bypassing inspection from existing spokes. What is the correct immediate correction?",
      options: [
        {
          id: "restore-symmetry",
          label:
            "Disable the propagation and add a static route for the new prefix via the inspection attachment in both relevant tables.",
          consequence:
            "Forward and return traffic use the inspection VPC, so the firewall sees complete flows. Reachability returns without weakening the inspection boundary.",
          quality: "good",
        },
        {
          id: "bypass-inspection",
          label: "Route the new spoke directly from every other spoke.",
          consequence:
            "Connectivity returns, but the new spoke is outside the central inspection policy. The organization now has an undocumented exception that is hard to find and harder to remove.",
          quality: "mixed",
        },
        {
          id: "rollback-spoke",
          label: "Detach the new spoke and postpone the migration.",
          consequence:
            "The failure stops, but the routing defect remains in the template. The next attachment repeats it, and the migration deadline moves without improving the design.",
          quality: "mixed",
        },
      ],
      debrief:
        "The fix is to make both directions choose the same security path. Removing the more-specific bypass and adding an explicit route via inspection restores that property. Bypassing inspection or rolling back the spoke only hides the asymmetry. The route table should express intent: all inter-spoke traffic goes through inspection, with no propagated exception that can override the summary.",
    },
    {
      id: "prevent-recurrence",
      prompt: "Which design and verification choices prevent the next asymmetric attachment?",
      options: [
        {
          id: "symmetric-by-design",
          label:
            "Use one association per attachment, keep propagation out of the spoke table, enable appliance mode, and test both directions in the pipeline.",
          consequence:
            "Route intent is explicit, flows stay pinned to an inspection AZ, and a bad association fails a test rather than a production connection. The design remains understandable to the next team.",
          quality: "good",
        },
        {
          id: "appliance-mode-only",
          label: "Enable appliance mode and rely on it to preserve symmetry.",
          consequence:
            "Appliance mode keeps a flow on the same inspection attachment, but it does not stop a more-specific route from bypassing inspection entirely. The original failure remains possible.",
          quality: "mixed",
        },
        {
          id: "single-az",
          label: "Force all inspection traffic through one availability zone.",
          consequence:
            "Flow symmetry becomes easier within that zone, but the inspection layer loses AZ resilience. An AZ failure now removes the security path for every spoke.",
          quality: "poor",
        },
      ],
      debrief:
        "Symmetry is a property of the route design, not a single feature. Associations decide which table an attachment uses; propagation and route specificity decide which path wins. Keep the spoke table free of more-specific inter-spoke routes, send all inter-spoke traffic through inspection, and use appliance mode to keep flows on one attachment. Then verify with a probe that opens a connection in each direction and checks firewall state, not just ICMP reachability.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A new spoke attachment propagated its prefix into the shared spoke route table. That /16 was more specific than the static summary route that sent inter-spoke traffic through the inspection VPC, so existing spokes bypassed inspection on the forward path. Return traffic still followed the summary into inspection, where the stateful firewall dropped it because it had not seen the opening SYN. The result was a bidirectional timeout with no missing route.",
    },
    { type: "h3", text: "What made it worse" },
    {
      type: "list",
      items: [
        "The landing-zone module enabled route propagation by default, so a routine attachment changed path selection.",
        "The spoke route table mixed a summary route with more-specific propagated routes.",
        "Health checks tested reachability, not a complete TCP flow through the inspection path.",
        "The firewall was suspected before the route lookup in each direction was compared.",
        "The inspection VPC used multiple attachments without appliance mode, adding a second asymmetry risk.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "Spoke attachments no longer propagate into the spoke route table; inter-spoke routes are explicit via inspection.",
        "The pipeline asserts route-table contents and rejects more-specific bypasses.",
        "A two-direction probe opens a TCP connection and verifies firewall state, not just ICMP.",
        "Appliance mode is enabled on the inspection attachment to pin flows to one availability zone.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "A transit gateway is a set of directional route tables, not a single routing domain. Forward and return paths can diverge whenever associations, propagation, or prefix specificity differ. Stateful inspection makes that divergence fatal rather than merely inefficient. Design the tables so both directions traverse the same appliances, and test with a real connection in both directions. A route that exists is not proof that the path is symmetric.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, route details, and observations in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Transit gateway route tables",
      url: "https://docs.aws.amazon.com/vpc/latest/tgw/tgw-route-tables.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Associations, propagation, static routes, and appliance mode.",
    },
    {
      title: "How transit gateways work",
      url: "https://docs.aws.amazon.com/vpc/latest/tgw/how-transit-gateways-work.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Attachment routing and transit gateway route selection.",
    },
    {
      title: "AWS Network Firewall deployment models",
      url: "https://docs.aws.amazon.com/network-firewall/latest/developerguide/deployment-models.html",
      publisher: "Amazon Web Services",
      kind: "docs",
      note: "Centralized inspection architectures and stateful traffic paths.",
    },
  ],
};
