import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "public",
  company: "GitLab",
  date: "January 31–February 1, 2017",
  incidentClass: "Accidental primary database deletion and failed backup restoration",
  accuracyNote:
    "Verified against GitLab's February 10 postmortem and its February 1 incident post. The postmortem gives clock times for the snapshot, load rise, replication failure, deletion, and restore; relative offsets are arithmetic from the 23:30 UTC deletion. The 300 GB and 4.5 GB figures, the estimates of 5,000 projects, 5,000 comments, and 700 users, and the 18-hour duration are GitLab's published figures. GitLab did not publish complete telemetry or every command; this file adds neither. The account of the engineer's mistake stays at the level GitLab published and does not identify the individual.",
  timeline: [
    {
      at: "T-06:10 · 17:20 UTC",
      title: "A fresh snapshot for staging",
      body: "An engineer takes an LVM snapshot of the production database and loads it into staging to test pgpool-II. The automatic snapshot normally runs once every 24 hours at 01:00 UTC; this one is manual and more recent.",
      tone: "info",
    },
    {
      at: "T-04:30 · 19:00 UTC",
      title: "Load rises",
      body: "Database load increases, initially attributed to spam. GitLab later finds that part of the load comes from a background job removing an employee whose account was flagged for abuse. Many users cannot post comments.",
      tone: "warn",
    },
    {
      at: "T-00:30 · 23:00 UTC",
      title: "Replication fails",
      body: "The secondary falls behind, and replication stops because WAL segments it needs have already been removed from the primary. GitLab is not using WAL archiving, so the secondary must be rebuilt manually.",
      tone: "warn",
    },
    {
      at: "T+00:00 · 23:30 UTC",
      title: "The primary is wiped",
      body: "An engineer intends to clear the PostgreSQL data directory on the secondary to start a clean rebuild. The command runs on the primary instead. The engineer stops it after one or two seconds, but about 300 GB is gone and only about 4.5 GB remains.",
      tone: "danger",
    },
    {
      at: "T+00:00–T+17:30",
      title: "Five recovery assumptions fail",
      body: "The S3 pg_dump bucket is empty. The dumps were failing because a PostgreSQL 9.2 binary ran against a 9.6 database, and failure emails were rejected because DMARC was not enabled. Azure disk snapshots were not enabled for database servers. Replication was broken on both hosts. Only the daily and manual LVM snapshots remain.",
      tone: "danger",
    },
    {
      at: "T+17:30 · Feb 1 17:00 UTC",
      title: "A six-hour-old snapshot is restored",
      body: "GitLab restores the LVM snapshot taken about six hours before the deletion. Copying the staging copy to production takes around 18 hours because the Azure disks are throttled to roughly 60 Mbps. The database comes back without webhooks.",
      tone: "warn",
    },
    {
      at: "T+18:30 · 18:00 UTC",
      title: "Service restored, data lost",
      body: "Webhooks are restored from a separate copy and final checks complete. Database changes between 17:20 and 23:30 UTC are lost: roughly 5,000 projects, 5,000 comments, and 700 user accounts. Git repositories and wikis are unaffected.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "first-response",
      prompt: "The primary data directory is gone and the secondary was already wiped. What is the first priority?",
      options: [
        {
          id: "stop-and-inventory",
          label: "Stop writes, preserve what remains, and inventory every recovery source.",
          consequence:
            "GitLab brought the site down and began looking for backups. Preserving the remaining data mattered because the normal recovery paths were already broken.",
          quality: "good",
        },
        {
          id: "promote-secondary",
          label: "Promote the secondary and keep serving.",
          consequence:
            "The secondary's data directory had been wiped during the replication repair. It could not serve as a disaster-recovery copy.",
          quality: "poor",
        },
        {
          id: "rebuild-secondary",
          label: "Re-run pg_basebackup from the primary to rebuild the secondary.",
          consequence:
            "The primary was the host that had just lost its data. Rebuilding from it cannot restore the deleted records.",
          quality: "poor",
        },
      ],
      debrief:
        "The instinct to restore service quickly can destroy the evidence and the remaining copies. GitLab stopped the site and inventoried what was left. That did not bring the data back, but it prevented further writes from making the recovery harder and let the team compare the remaining sources. In a data-loss incident, the first priority is to stop making new irreversible changes.",
    },
    {
      id: "restore-source",
      prompt: "Which backup do you restore?",
      options: [
        {
          id: "six-hour-snapshot",
          label: "The LVM snapshot taken about six hours before the deletion.",
          consequence:
            "GitLab chose it to minimize data loss; the alternative was a snapshot almost 24 hours old. The cost was a slow copy from staging on throttled disks.",
          quality: "good",
        },
        {
          id: "daily-snapshot",
          label: "The daily LVM snapshot from almost 24 hours earlier.",
          consequence:
            "It was available, but it would have increased data loss. GitLab used the newer snapshot instead and accepted the longer copy time.",
          quality: "mixed",
        },
        {
          id: "s3-dump",
          label: "The S3 pg_dump backup.",
          consequence:
            "The bucket was empty. The dumps had been failing silently because of the version mismatch, and the failure emails were rejected.",
          quality: "poor",
        },
      ],
      debrief:
        "Restore choice is an RPO decision made under pressure. The six-hour snapshot lost less data than the daily snapshot, but it lived in staging on slow storage, so the restore took much longer. GitLab chose the lower data loss and paid in recovery time. The important point is that the choice was only available because someone had taken a manual snapshot for an unrelated load test. That is luck, not a recovery strategy.",
    },
    {
      id: "restore-proof",
      prompt: "What would have exposed the backup problem before the outage?",
      options: [
        {
          id: "restore-test",
          label: "A scheduled restore test that proves each path and reports failure to a monitored channel.",
          consequence:
            "The pg_dump job failed silently, the S3 bucket was empty, Azure disk snapshots were not enabled for databases, and nobody owned testing. A restore test with an independent alert would have exposed all of those.",
          quality: "good",
        },
        {
          id: "more-frequent-dumps",
          label: "More frequent pg_dump runs.",
          consequence:
            "Frequency does not help if the dump exits with an error and the alert is rejected. GitLab's issue was proof, not cadence.",
          quality: "mixed",
        },
        {
          id: "second-replica",
          label: "A second hot-standby replica.",
          consequence:
            "Replication helps failover, but both hosts were wiped during the repair, and replication is not a backup. It does not protect against deletion or corruption that reaches both nodes.",
          quality: "poor",
        },
      ],
      debrief:
        "A backup is a claim until a restore proves it. GitLab had five mechanisms and none was reliable: the dump was incompatible, the bucket was empty, the disk snapshots were not enabled, replication was broken, and the LVM snapshots were not designed for disaster recovery. The missing control was not another copy; it was ownership and a recurring test that restored into a clean environment and alerted when it failed.",
    },
    {
      id: "transparency",
      prompt: "How should the recovery be communicated?",
      options: [
        {
          id: "live-notes",
          label: "Publish live operational notes and status updates, with personal names redacted.",
          consequence:
            "GitLab published a public Google Doc, streamed the recovery, and used status updates. It later said it would redact names in future because the first document exposed the engineer's name.",
          quality: "good",
        },
        {
          id: "publish-all",
          label: "Publish everything, including the engineer's name, because the engineer agreed.",
          consequence:
            "The engineer had no problem with it, but GitLab concluded that other engineers might not be comfortable. Consent for one person is not a policy for everyone.",
          quality: "mixed",
        },
        {
          id: "say-nothing",
          label: "Say nothing until the restoration is complete.",
          consequence:
            "GitLab's public notes and stream gave users visibility during a long outage. Silence would have left them without status or expectations.",
          quality: "poor",
        },
      ],
      debrief:
        "Transparency during a long recovery is useful, but it needs a privacy rule. GitLab showed live progress and later recognized that naming the engineer was a mistake in process even though that engineer consented. A blameless postmortem does not require exposing an individual, and a public timeline does not require raw internal notes. Publish the operational facts, protect the people, and keep the technical detail.",
    },
  ],
  postmortem: [
    { type: "h3", text: "What happened" },
    {
      type: "p",
      text: "A replication repair on GitLab.com's PostgreSQL pair went wrong when an engineer wiped the primary data directory instead of the secondary. The secondary had already been wiped as part of the same repair, so neither host could serve. The S3 pg_dump backups were empty, the disk snapshots were not enabled for databases, and replication was broken. GitLab restored a six-hour-old LVM snapshot from staging, lost database changes made between 17:20 and 23:30 UTC, and brought the service back after about 18 hours.",
    },
    { type: "h3", text: "The five recovery assumptions that failed" },
    {
      type: "list",
      items: [
        "pg_dump: the job used a 9.2 binary against a 9.6 database and exited with an error.",
        "S3 storage: the bucket was empty because the failed dumps never produced usable files.",
        "Failure alerting: cron email was rejected because DMARC was not enabled, so nobody saw the errors.",
        "Azure disk snapshots: enabled for NFS servers, not for database servers.",
        "Replication and LVM: replication was broken on both hosts, and the LVM snapshots were for staging refreshes, not disaster recovery.",
      ],
    },
    { type: "h3", text: "What changed" },
    {
      type: "list",
      items: [
        "LVM snapshots moved from daily to hourly.",
        "GitLab worked on Azure disk snapshots for production databases.",
        "Point-in-time recovery and continuous archiving were investigated.",
        "Restore testing was automated and assigned an owner.",
        "Backup monitoring, replication runbooks, and host identification were improved.",
      ],
    },
    { type: "h3", text: "What generalizes" },
    {
      type: "p",
      text: "Replication is not a backup, and a backup is not proven until it restores. Each recovery path needs an owner, a test that runs on a schedule, and an alert that reaches someone when the test fails. The test must restore into a clean environment; a job that exits successfully is not evidence. RPO and restore time are separate budgets, and the source you can actually restore may be older and slower than the one you assumed.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Time notation",
      body: "Relative offsets are arithmetic from GitLab's published 23:30 UTC deletion. Clock times and quantities come from the two GitLab posts; the failed-backup search is shown as a phase because GitLab did not publish a single timestamp for it.",
    },
  ],
  sources: [
    {
      title: "Postmortem of database outage of January 31",
      url: "https://about.gitlab.com/blog/2017/02/10/postmortem-of-database-outage-of-january-31/",
      publisher: "GitLab Blog",
      kind: "postmortem",
      note: "Detailed timeline, failed recovery paths, data-loss estimate, and remediation issues.",
    },
    {
      title: "GitLab.com database incident",
      url: "https://about.gitlab.com/blog/gitlab-dot-com-database-incident/",
      publisher: "GitLab Blog",
      kind: "docs",
      note: "Initial incident report with deletion time, remaining data, and recovery start.",
    },
    {
      title: "Continuous Archiving and Point-in-Time Recovery",
      url: "https://www.postgresql.org/docs/current/continuous-archiving.html",
      publisher: "PostgreSQL Documentation",
      kind: "docs",
      note: "PITR and WAL archiving concepts referenced in GitLab's remediation.",
    },
  ],
};
