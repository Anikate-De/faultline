import { useEffect, useRef, useState } from "react";
import { Beaker, FlaskConical, Play, RotateCcw, SkipForward } from "lucide-react";
import type { Experiment } from "@/content/types";
import type { SimulationController } from "@/simulation/engine/useSimulation";
import { useAppStore } from "@/lib/store";
import { useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { PredictionPicker, RevealPanel } from "@/components/ui/Reveal";
import { Badge } from "@/components/ui/Badge";

export function ExperimentCard({
  experiment,
  controllerRef,
}: {
  experiment: Experiment;
  controllerRef: React.RefObject<SimulationController | null>;
}) {
  const interviewMode = useAppStore((s) => s.interviewMode);
  const reducedMotion = useReducedMotion() ?? false;
  const [prediction, setPrediction] = useState("");
  const [phase, setPhase] = useState<"idle" | "running" | "ran" | "fixed">("idle");
  const [revealOutcome, setRevealOutcome] = useState(false);
  const [ready, setReady] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    let attempts = 0;
    const check = () => {
      if (!alive) return;
      if (controllerRef.current) setReady(true);
      else if (attempts++ < 20) window.setTimeout(check, 50);
    };
    check();
    return () => {
      alive = false;
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [controllerRef]);

  const controller = () => controllerRef.current;
  const outcomeVisible = (phase === "ran" || phase === "fixed") && (!interviewMode || revealOutcome);

  function clearTimer() {
    if (timer.current) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
  }

  function run() {
    const sim = controller();
    if (!sim) return;
    clearTimer();
    setRevealOutcome(false);
    setPhase("running");
    document.querySelector<HTMLElement>("[data-sim-ready]")?.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "center",
    });
    sim.startLive(experiment.setup);
    const started = performance.now();
    timer.current = window.setInterval(() => {
      const frame = controller()?.getFrame();
      if (frame && frame.t >= experiment.runFor - 0.05) {
        controller()?.pause();
        clearTimer();
        setPhase("ran");
      } else if (performance.now() - started > 180_000) {
        controller()?.pause();
        clearTimer();
        setPhase("ran");
      }
    }, 100);
  }

  function skip() {
    const sim = controller();
    if (!sim) return;
    clearTimer();
    sim.fastForward(experiment.runFor, experiment.setup);
    setPhase("ran");
    setRevealOutcome(false);
  }

  function applyFix() {
    const sim = controller();
    if (!sim) return;
    clearTimer();
    sim.fastForward(experiment.runFor, { ...experiment.setup, ...experiment.fix });
    setPhase("fixed");
    setRevealOutcome(false);
  }

  return (
    <section className="rounded-[16px] border border-border bg-surface p-4 sm:p-5" aria-labelledby={`${experiment.id}-title`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge tone="info">
          <Beaker aria-hidden="true" className="size-3.5" />
          Guided experiment
        </Badge>
        <span className="font-mono text-xs text-faint">{experiment.runFor}s run</span>
      </div>
      <h3 id={`${experiment.id}-title`} className="text-base font-semibold text-text">
        {experiment.title}
      </h3>
      <p className="mt-1 text-sm leading-relaxed text-muted">{experiment.question}</p>

      <div className="mt-4">
        <PredictionPicker
          options={experiment.prediction.options}
          value={prediction}
          onChange={setPrediction}
          correctId={experiment.prediction.correctOptionId}
          revealed={outcomeVisible}
          question="Predict the outcome before you run it."
          explanation={experiment.prediction.explanation}
        />
      </div>

      {interviewMode && (phase === "ran" || phase === "fixed") && !revealOutcome ? (
        <div className="mt-4">
          <Button variant="interview" size="sm" onClick={() => setRevealOutcome(true)}>
            Reveal prediction result
          </Button>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {phase === "idle" ? (
          <Button variant="primary" onClick={run} disabled={!prediction || !ready}>
            <Play aria-hidden="true" className="size-4" />
            Run {experiment.runFor}s
          </Button>
        ) : null}
        {phase === "running" ? (
          <>
            <Button variant="secondary" onClick={skip}>
              <SkipForward aria-hidden="true" className="size-4" />
              Skip to result
            </Button>
            <span role="status" className="self-center text-xs text-muted">
              Running live. The sim is applying the setup.
            </span>
          </>
        ) : null}
        {phase === "ran" || phase === "fixed" ? (
          <>
            {experiment.fix ? (
              <Button variant="primary" onClick={applyFix} disabled={phase === "fixed"}>
                <FlaskConical aria-hidden="true" className="size-4" />
                Apply fix and re-run
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => { clearTimer(); setPhase("idle"); setRevealOutcome(false); controller()?.reset(); }}>
              <RotateCcw aria-hidden="true" className="size-4" />
              Reset experiment
            </Button>
          </>
        ) : null}
      </div>

      {outcomeVisible ? (
        <div className="mt-4 space-y-3">
          <div>
            <h4 className="mb-1 font-mono text-[11px] uppercase tracking-[0.08em] text-faint">Observe</h4>
            <ul className="space-y-1 text-sm text-muted">
              {experiment.observe.map((item) => (
                <li key={item} className="flex gap-2">
                  <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-info" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <RevealPanel label="Why the result happened" hint="Reveal after you have committed to an explanation.">
            <p>{experiment.explain}</p>
            {phase === "fixed" ? (
              <div className="mt-3">
                <Callout tone="success" title="Fix applied">
                  {experiment.debrief}
                </Callout>
              </div>
            ) : null}
          </RevealPanel>
        </div>
      ) : null}
    </section>
  );
}
