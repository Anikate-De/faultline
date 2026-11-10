# Faultline — Product

Faultline is a mobile-first, static web app that teaches site reliability engineering and DevOps through interactive failure simulations. Every module answers one production question, lets the learner break a realistic system, shows the signals, and teaches the diagnosis and the fix.

## Audience

- SREs and DevOps engineers with 0–3 years of experience.
- Developers moving into on-call or platform work.
- Interview candidates preparing for reliability, infrastructure, and incident-response rounds.

## Teaching arc

1. Production question.
2. Primer: what it is, where it sits, what you will see.
3. Simulator: break the system, read the signals.
4. Guided experiment: predict, run, observe, fix, re-run.
5. Debrief: production signals, fix, tradeoffs.
6. Interview drill with hidden answers.
7. Production checklist.
8. References.

## Non-negotiables

- Explain before interact.
- Failure is obvious without animation or color alone.
- Answers stay hidden until an explicit reveal.
- One module, one learning delta.
- Deterministic simulations.
- Mobile-first at 360–390px, desktop-rich at 1440px.
- No backend, no runtime network calls, no tracking.
- The production build is a PWA with an explicit offline-save panel; authored content, fonts, and simulation chunks are precached on the device.
- Manifest before module agents; demo approval before scale.

## Routes

`/`, `/tracks`, `/tracks/:trackId`, `/curriculum`, `/modules/:slug`, `/case-files`, `/case-files/:slug`, `/review`, `/glossary`, `/progress`, `/about`, `/_lab`, `*`.

## Non-goals

- A Kubernetes track in this build. The track is reserved and visibly empty.
- A backend, accounts, sync, analytics, or third-party runtime APIs.
- Shallow filler to reach a module count.
