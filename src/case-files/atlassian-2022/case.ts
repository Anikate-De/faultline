import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "public",
  company: "Atlassian",
  date: "April 5, 2022",
  incidentClass: "Destructive control-plane action and multi-day restoration",
  accuracyNote:
    "Verified against Atlassian's post-incident review, published April 29, 2022. All clock times are UTC as stated there. The review gives 883 deleted sites and 775 affected customers; early estimates of roughly 400 were superseded by that review. Restoration durations are the review's own approximations; exact restore times for individual customers are not public. The review does not name the internal script, the API, or individual customers, so this case does not either. No telemetry, quotations, or customer details are invented.",
  timeline: [
    {
      at: "T+00:00",
      title: "A deletion script starts running",
      body: "At 07:38 UTC, an existing script begins deleting the legacy Insight app across a list of target sites. It processes the list sequentially, so the first customer site is deleted shortly after the run begins.",
      tone: "warn",
    },
    {
      at: "T+00:23",
      title: "883 sites are gone",
      body: "The script completes at 08:01 UTC. It had been given cloud site IDs instead of app IDs. The API accepted both identifier types and assumed the input was correct, so it deleted entire sites rather than one app. No warning fired.",
      tone: "danger",
    },
    {
      at: "T+00:39",
      title: "Major incident declared",
      body: "At 08:17 UTC the incident is confirmed and Atlassian triggers its major incident management process. Internal monitoring had not detected the deletion because the script used a standard workflow.",
      tone: "danger",
    },
    {
      at: "T+01:15",
      title: "The script is identified",
      body: "At 08:53 UTC the team identifies the Insight app script as the cause and confirms this was not a cyberattack. Product and platform teams are paged. The same deletion removed contact identifiers such as cloud URLs and site system administrators.",
      tone: "warn",
    },
    {
      at: "Same day",
      title: "Communication becomes part of the outage",
      body: "Affected customers cannot use the normal support form, which requires an Atlassian ID and valid cloud URL. Atlassian works to contact approved owners while beginning restoration.",
      tone: "warn",
    },
    {
      at: "T+3d",
      title: "First sites return",
      body: "On April 8, the first affected customers are restored. The initial restoration approach takes about 48 hours per batch and is used for 53% of affected users across 112 sites between April 5 and April 14.",
      tone: "info",
    },
    {
      at: "T+9d",
      title: "Restoration accelerates",
      body: "An optimized approach reduces restoration to about 12 hours per site. Between April 14 and April 17 it restores approximately 47% of affected users across 771 sites.",
      tone: "info",
    },
    {
      at: "T+13d",
      title: "All sites restored",
      body: "By April 18 every affected site is back. No customer lost more than five minutes of data, and Atlassian reports meeting its one-hour recovery point objective. A later audit finds 57 early restores that went further back than five minutes; that data is recovered afterward.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "deletion-api-boundary",
      prompt:
        "A maintenance API accepts either a site identifier or an app identifier and deletes whatever it receives. Where should the control go?",
      options: [
        {
          id: "typed-confirmation",
          label:
            "Require a typed resource identifier, confirm the resource type, and run a reversible dry run before execution.",
          consequence:
            "A site ID cannot be mistaken for an app ID, and the operator sees the blast radius before deletion. The control catches the error at the boundary instead of trusting the caller's list.",
          quality: "good",
        },
        {
          id: "peer-review",
          label: "Keep the API as is and rely on peer review of the calling script.",
          consequence:
            "Reviewers see the endpoint and the code path but not the provenance of every ID. Atlassian's review focused on which endpoint was called and how, and still approved the run.",
          quality: "poor",
        },
        {
          id: "post-hoc-alert",
          label: "Add an alert that fires when an unusually large deletion completes.",
          consequence:
            "The team learns quickly, but only after the sites are gone. Detection shortens the response; it does not prevent the destructive action.",
          quality: "mixed",
        },
      ],
      debrief:
        "The script passed peer review and a staging test. Neither could catch the mistake: the review examined the endpoint rather than the identifier semantics, and staging did not contain the production IDs. Controls that depend on humans noticing the wrong kind of ID are fragile. The API knew whether it had received a site or an app; it should have refused an ambiguous operation without explicit typed confirmation.",
    },
    {
      id: "restore-sequencing",
      prompt:
        "Hundreds of sites are deleted and the restore pipeline has never run at this scale. How do you sequence recovery?",
      options: [
        {
          id: "batched-pipeline",
          label:
            "Restore in batches through a validated, repeatable pipeline and publish status per batch.",
          consequence:
            "Each batch proves the process and gives the team a recovery time it can forecast. Consistency checks and communication can be built into the pipeline rather than handled ad hoc.",
          quality: "good",
        },
        {
          id: "parallel-all",
          label: "Start every site in parallel to minimize the time to first restore.",
          consequence:
            "The pipeline competes for the same databases, snapshots, and people. Failures are harder to attribute and inconsistent restore points become more likely, not less.",
          quality: "poor",
        },
        {
          id: "largest-first",
          label: "Restore the largest customers first, then backfill the rest.",
          consequence:
            "Some high-value customers return sooner, but the ordering is hard to defend and the remaining customers wait without a predictable date. The pipeline still has to be proven at scale.",
          quality: "mixed",
        },
      ],
      debrief:
        "Atlassian used two approaches. The first took about 48 hours per batch and restored 53% of users across 112 sites; the second took about 12 hours per site and restored the remaining 47% across 771 sites. The improvement came from optimizing the pipeline, not skipping validation. A fixed restore point five minutes before deletion kept primary stores consistent, and the team accepted a bounded data-loss window.",
    },
    {
      id: "deletion-safety",
      prompt: "What control most reduces the chance of another destructive action at this scale?",
      options: [
        {
          id: "universal-soft-delete",
          label:
            "Make soft delete universal, with retention, multi-level protection, and regularly exercised restore.",
          consequence:
            "A mistaken deletion becomes recoverable within a known window. The control changes the default from permanent removal to a reversible state, and exercises prove the restore path before it is needed.",
          quality: "good",
        },
        {
          id: "remove-access",
          label: "Remove production access from the team that ran the script.",
          consequence:
            "The immediate path is closed, but the underlying API still accepts either identifier type. Another team with legitimate access can repeat the mistake.",
          quality: "mixed",
        },
        {
          id: "rely-on-backups",
          label: "Keep the existing backups and rely on point-in-time restore if it happens again.",
          consequence:
            "Backups existed and did prevent permanent data loss, but restoring hundreds of sites still took up to 14 days. Backup coverage is not the same as a tested recovery capability, and Atlassian committed to accelerating DR to meet its defined RTO for this scale.",
          quality: "poor",
        },
      ],
      debrief:
        "Atlassian's own conclusion was that an entire-site deletion should be prohibited, and that soft delete should require multiple layers of protection. Backups limited data loss to five minutes, but restoring hundreds of sites took up to 14 days, and Atlassian committed to accelerating its disaster recovery program to meet the RTO defined for this scale. The two measures answer different questions: backups bound data loss, while tested soft-delete and restore bound customer impact.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "Atlassian needed to remove a legacy app after integrating its functionality into Jira Service Management. The requesting team supplied cloud site IDs rather than the app IDs. The deletion API accepted both, and the script deleted 883 sites belonging to 775 customers between 07:38 and 08:01 UTC.",
    },
    { type: "h3", text: "Why recovery took days" },
    {
      type: "list",
      items: [
        "The restore pipeline had not been exercised at this scale.",
        "The deletion also removed cloud URLs and system administrator contacts that support, licensing, and billing used as identifiers.",
        "The normal support form required a valid cloud URL, so many affected customers could not open a ticket.",
        "Internal monitoring saw a standard deletion workflow and did not raise an alert.",
        "Early restores for 57 customers lacked consistent policies and manual snapshot retrieval, and some databases were restored to a point more than five minutes before deletion, requiring later recovery work.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "Atlassian committed to universal soft delete, with retention and multiple protections before production data is permanently removed.",
        "Atlassian committed to an accelerated disaster recovery program with exercises that restore all products for many sites.",
        "Atlassian committed to a revised incident management process for large-scale events, practiced with simulations.",
        "Atlassian committed to a large-scale communications playbook, including backup contact data and support access without a valid site URL.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "A destructive action is a data-loss incident even when the data is eventually recovered. The relevant controls sit before execution: typed identifiers, explicit confirmation of what will be deleted, and a default that makes deletion reversible. Review and staging cannot catch production IDs that staging does not contain.",
    },
    {
      type: "p",
      text: "Recovery time is end-to-end: finding and contacting affected customers, provisioning infrastructure, restoring each product consistently, and verifying the result. Atlassian could identify the affected sites immediately, but contact data had been deleted with them. A restore plan that assumes communication channels and identifiers still exist is incomplete.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Data loss versus customer impact",
      body: "Atlassian reports that no customer lost more than five minutes of data and that its one-hour RPO was met. That is a data-loss result, not a recovery-time result: some customers waited up to 14 days for access. Both measures belong in the incident review.",
    },
  ],
  sources: [
    {
      title: "Post-Incident Review on the Atlassian April 2022 outage",
      url: "https://www.atlassian.com/blog/how-we-build/post-incident-review-april-2022-outage",
      publisher: "Atlassian",
      kind: "postmortem",
      note: "Primary source for the timeline, affected counts, restoration approach, and corrective actions.",
    },
    {
      title: "Atlassian cloud outage postmortem seeks to build back trust",
      url: "https://www.techtarget.com/news/Atlassian-cloud-outage-postmortem-seeks-to-build-back-trust/861276/",
      publisher: "TechTarget",
      kind: "docs",
      note: "Independent reporting used to cross-check the customer count and publication date.",
    },
    {
      title: "Atlassian finally explains the cause of ongoing cloud outage",
      url: "https://www.bleepingcomputer.com/news/technology/atlassian-finally-explains-the-cause-of-ongoing-cloud-outage/",
      publisher: "BleepingComputer",
      kind: "docs",
      note: "Early reporting used only to confirm the initial public estimate was later revised.",
    },
  ],
};
