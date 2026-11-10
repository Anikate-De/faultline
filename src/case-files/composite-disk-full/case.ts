import type { CaseStudy } from "@/content/types";

export const caseStudy: CaseStudy = {
  kind: "composite",
  company: "Faultline composite",
  date: "Illustrative",
  incidentClass: "Disk exhaustion from unbounded logging on a database host",
  accuracyNote:
    "This is an original composite scenario, not a real incident. It combines common logging, retention, disk-growth, and write-outage failure modes into one representative case. It does not describe any company's architecture, dates, traffic, or internal decisions. All times and telemetry are illustrative.",
  timeline: [
    {
      at: "T+00:00",
      title: "Verbose logging is enabled",
      body: "An engineer enables statement logging to investigate a slow query. The new log file is written to the same volume as the database, and the existing rotation rule does not match its path.",
      tone: "warn",
    },
    {
      at: "T+04:00",
      title: "Growth outpaces the threshold",
      body: "The volume grows by roughly two gigabytes per hour. The only disk alert fires at 95 percent utilization with a fifteen-minute evaluation, which leaves about half an hour before the filesystem is full at the current rate.",
      tone: "warn",
    },
    {
      at: "T+09:00",
      title: "The filesystem reaches 100 percent",
      body: "The database cannot write new write-ahead log segments. It stops accepting writes and moves into a read-only state. Application health checks fail, and the write queue begins to back up.",
      tone: "danger",
    },
    {
      at: "T+09:05",
      title: "The write outage pages",
      body: "Write failures page the on-call. Disk usage is at 100 percent while inode usage is normal, which points to bytes rather than file count. The verbose log is the largest recent file.",
      tone: "danger",
    },
    {
      at: "T+09:12",
      title: "Space is freed safely",
      body: "The on-call rotates and compresses the verbose log, removes an old core dump, and extends the volume. The team checks that write-ahead log segments are archived before considering any removal.",
      tone: "warn",
    },
    {
      at: "T+09:25",
      title: "The database recovers",
      body: "With free space available, the database restarts, replays its log, and accepts writes again. The application drains the queued mutations and returns to its normal latency.",
      tone: "success",
    },
    {
      at: "T+10:10",
      title: "Service is restored",
      body: "Checkout and background jobs are healthy. The incident lasted just over an hour, and the volume is left with more free space than it had before the logging change.",
      tone: "success",
    },
  ],
  decisions: [
    {
      id: "free-space",
      prompt: "The database volume is full and writes are failing. What is the first move?",
      options: [
        {
          id: "safe-cleanup",
          label:
            "Remove or compress recent logs and temporary files, extend the volume, and verify archive state before touching write-ahead log segments.",
          consequence:
            "Space returns without destroying recovery material. The database can restart and replay, and the team avoids a data-loss decision made under pressure.",
          quality: "good",
        },
        {
          id: "delete-wal",
          label: "Delete the oldest write-ahead log segments to make room immediately.",
          consequence:
            "Space appears quickly, but segments may be needed for recovery or replication. The write outage can turn into data loss or a failed replica that cannot catch up.",
          quality: "poor",
        },
        {
          id: "restart-first",
          label: "Restart the database before freeing space.",
          consequence:
            "The restart fails or immediately returns to the same read-only state because there is still no room to write. The team adds downtime without changing the condition.",
          quality: "poor",
        },
      ],
      debrief:
        "When a database volume is full, the fastest reversible space is usually logs, temporary files, or an attached volume, not recovery material. Write-ahead log segments are part of the durability contract. Check archive and replication state before removing them, and prefer adding space when the safe cleanup is not obvious.",
    },
    {
      id: "prevent-recurrence",
      prompt: "Which controls should have caught this before 03:00?",
      options: [
        {
          id: "forecast-and-separate",
          label:
            "Separate log and data volumes, cap retention, and alert when the projected time to full is under four hours.",
          consequence:
            "The volume grows predictably within a bounded budget, and the alert arrives with time to act. A log storm cannot consume the database's write capacity.",
          quality: "good",
        },
        {
          id: "raise-threshold",
          label: "Raise the disk alert from 95 to 99 percent so it fires less often.",
          consequence:
            "The alert is quieter, but at two gigabytes per hour there is almost no time between notification and a write outage. Fewer pages are traded for a shorter response window.",
          quality: "poor",
        },
        {
          id: "bigger-disk",
          label: "Attach a larger volume and keep the current retention and alerting.",
          consequence:
            "The outage moves further into the future. Growth is unchanged, retention is still unbounded, and the next log burst arrives with an even larger volume to fill.",
          quality: "mixed",
        },
      ],
      debrief:
        "Disk exhaustion is one of the few failures with a visible countdown. Growth rate matters more than a fixed percentage: 95 percent is urgent on a volume that fills in thirty minutes and comfortable on one that fills in a week. Separate volumes, retention caps, and a projected-time-to-full alert turn the countdown into a planned action.",
    },
  ],
  postmortem: [
    {
      type: "h3",
      text: "What happened",
    },
    {
      type: "p",
      text: "Verbose statement logging was enabled on a database host and wrote to the same volume as the data. The new file was outside the rotation rule, the volume filled at about two gigabytes per hour, and the fixed 95 percent threshold left too little time to respond. When the filesystem reached 100 percent, the database could not write its log and stopped accepting writes until space was freed.",
    },
    {
      type: "h3",
      text: "What made it worse",
    },
    {
      type: "list",
      items: [
        "Logs, write-ahead segments, and data shared one volume, so a logging change could stop database writes.",
        "The alert used a fixed percentage instead of projected time to full and had no growth-rate signal.",
        "The new log path was not included in rotation or retention review.",
        "The initial response considered deleting write-ahead segments before checking archive state.",
      ],
    },
    {
      type: "h3",
      text: "What changed",
    },
    {
      type: "list",
      items: [
        "Logs and temporary files have their own volume with a retention cap and rotation test.",
        "Disk alerts fire on projected time to full and on abnormal growth, not only on a percentage.",
        "The database runbook forbids removing write-ahead segments until archive and replica state are verified.",
        "A monthly check confirms that every new log path matches a rotation rule.",
      ],
    },
    {
      type: "h3",
      text: "What generalizes",
    },
    {
      type: "p",
      text: "A full disk is a capacity incident with a known direction of travel. The useful signal is not 95 percent but how long remains at the current rate. Keeping logs away from durability-critical files, bounding retention, and alerting on the forecast converts a 03:00 write outage into an afternoon cleanup.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Illustrative telemetry",
      body: "All times, growth rates, and capacity figures in this file are illustrative. They describe a composite scenario and are not measurements from any real system.",
    },
  ],
  sources: [
    {
      title: "Disk Usage",
      url: "https://www.postgresql.org/docs/current/diskusage.html",
      publisher: "PostgreSQL Documentation",
      kind: "docs",
      note: "Disk space monitoring and write-ahead log storage.",
    },
    {
      title: "journald.conf",
      url: "https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html",
      publisher: "systemd Documentation",
      kind: "docs",
      note: "Journal retention, rotation, and disk usage limits.",
    },
    {
      title: "node_exporter",
      url: "https://github.com/prometheus/node_exporter",
      publisher: "Prometheus Project",
      kind: "docs",
      note: "Filesystem usage and inode metrics used for growth alerts.",
    },
  ],
};
