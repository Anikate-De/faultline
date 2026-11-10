import { Link } from "react-router-dom";
import { BookOpen, Brain, EyeOff, Gauge, Lock, MonitorSmartphone, ShieldCheck } from "lucide-react";
import { MANIFEST, CASE_FILES } from "@/content/manifest";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";

export default function About() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent">About</p>
        <h1 className="mt-1">An interactive SRE and DevOps field lab</h1>
        <p className="mt-2 text-base leading-relaxed text-muted">
          Faultline teaches production reliability through failure. Every module answers one question, lets you
          break a realistic system, shows the signal, and makes you choose a fix and its tradeoff.
        </p>
      </header>

      <Callout tone="info" title="How the lab is built">
        Static React app. No backend, no auth, no analytics, no runtime API calls. Simulations are deterministic
        models with a seeded random number generator; telemetry is illustrative, not a replay of a real system.
      </Callout>

      <section className="grid gap-3 sm:grid-cols-2">
        {[
          { icon: BookOpen, title: "Explain before interact", body: "Primer first: what it is, where it sits, what you will see. The simulator comes after." },
          { icon: Gauge, title: "Breakage is obvious", body: "Banner, node state, threshold, event, and causal chain agree. Failure is visible while paused." },
          { icon: EyeOff, title: "Answers stay hidden", body: "Predictions, experiment explanations, quiz keys, and interview answers require an explicit reveal." },
          { icon: Lock, title: "One module, one delta", body: "Every module adds a distinct failure mode, signal, or tradeoff. No repeated intros." },
          { icon: MonitorSmartphone, title: "Mobile-first", body: "Designed at 360–390px, rich at 1440px. Focus mode works on a phone." },
          { icon: Brain, title: "Interview mode", body: "Hide model answers, use hints one at a time, rate confidence, and feed a spaced review queue." },
        ].map((item) => (
          <div key={item.title} className="rounded-[12px] border border-border bg-surface p-4">
            <item.icon aria-hidden="true" className="size-4 text-accent" />
            <h2 className="mt-2 text-sm font-semibold text-text">{item.title}</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted">{item.body}</p>
          </div>
        ))}
      </section>

      <section className="rounded-[16px] border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">How simulations work</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          A model exposes sliders, presets, thresholds, and causal insights. The engine steps it at a fixed 100ms
          timestep, caps series, deduplicates events, and clamps values. The same seed and parameters produce the
          same frame. A failure preset must cross a critical threshold within 60 simulated seconds; a recovery
          preset must return to healthy. Particle counts are capped, simulations pause off-screen, and reduced
          motion keeps every state change legible.
        </p>
        <p className="mt-2 text-xs text-faint">
          Numbers in simulations are illustrative unless a documented provider limit is named. A simulation is a
          teaching model, not a capacity guarantee.
        </p>
      </section>

      <section className="rounded-[16px] border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">The curriculum</h2>
        <div className="mt-2 grid gap-2 text-sm text-muted sm:grid-cols-3">
          <p><span className="font-mono text-text">{MANIFEST.length}</span><br />modules in the frozen manifest</p>
          <p><span className="font-mono text-text">{CASE_FILES.length}</span><br />case files, real and composite</p>
          <p><span className="font-mono text-text">14</span><br />active tracks plus Kubernetes reserved</p>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-faint">
          Only authored modules appear in search and routes. Planned rows show an honest “in authoring” state. Case
          files are researched separately; real incidents cite public postmortems, and composites are labeled at
          the top of the page.
        </p>
      </section>

      <section className="rounded-[16px] border border-border bg-surface p-5">
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck aria-hidden="true" className="size-4 text-success" />
          <h2 className="text-sm font-semibold text-text">Privacy and accessibility</h2>
          <Badge tone="success">Local only</Badge>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Progress is stored in this browser's localStorage and can be exported or reset. There are no accounts,
          cookies, trackers, or network calls. The app targets WCAG 2.2 AA: keyboard operation, visible focus,
          labeled controls, text alternatives for charts, non-color state labels, reduced-motion support, and
          aria-live incident announcements.
        </p>
      </section>

      <section className="rounded-[16px] border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text">Kubernetes is deferred</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          The Kubernetes track is intentionally empty. It is reserved for a later build so it can be learned from
          a clean baseline instead of as a bolt-on. There are no fake Kubernetes lessons in this build.
        </p>
        <Link to="/tracks/kubernetes" className="mt-2 inline-flex text-sm text-accent hover:underline">
          See the reserved track
        </Link>
      </section>

      <p className="text-xs text-faint">
        Faultline · Built as a static field lab · Content reviewed 2026-11-10 · No affiliation with the vendors named in lessons.
      </p>
    </div>
  );
}
