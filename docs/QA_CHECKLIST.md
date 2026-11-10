# Faultline — QA Checklist

## Every module

- [ ] Meta matches the frozen manifest row (ID, track, order, title, purpose, delta).
- [ ] Primer explains what it is, where it sits, what you will see, before any slider.
- [ ] 3–6 parameters with labels, units, numeric entry, and keyboard support.
- [ ] Healthy, peak, failure, recovery presets. Failure crosses critical quickly; recovery returns to ok.
- [ ] Incident banner, node state, threshold marker, event, and causal panel agree.
- [ ] Failure is obvious while paused; no reliance on animation or color alone.
- [ ] Experiment prediction and explanation hidden until run/reveal.
- [ ] 3–5 interview questions; hints one at a time; answers hidden.
- [ ] Debrief has causal chain, production signals, ordered fix, tradeoffs.
- [ ] “What to check first” list and at least one tradeoff.
- [ ] 2+ real references, verified; no invented numbers.
- [ ] 700–1,800 words; no placeholders, raw HTML, localhost links, or `example.com`.
- [ ] Deterministic tests: same seed/params/ticks; finite values; failure/recovery windows; dedupe; `runFor` equivalence.

## Mobile and desktop

- [ ] 360×800 and 390×844: no horizontal page scroll; no clipped labels; no tiny controls.
- [ ] 768×1024 and 1440×900: layout intact; sticky sim does not cover content.
- [ ] Bottom nav does not obscure the last line; safe-area padding respected.
- [ ] Charts readable; tables become cards; comparisons stack; sim reflows vertically.
- [ ] Sliders: label, value, unit, number input, ± steppers, 44px targets.
- [ ] Focus mode opens, locks body scroll, closes obviously, works on phone and desktop.
- [ ] Dark and light themes pass contrast.
- [ ] Reduced motion keeps state changes understandable.

## Accessibility

- [ ] Axe clean on home, track, module, case file, review, progress, search.
- [ ] Keyboard-only pass: skip link, nav, sliders, reveal, focus mode, dialog.
- [ ] Focus visible; icon buttons labeled; landmarks present.
- [ ] Incident uses `role="status"`/`aria-live`; charts have text summaries.
- [ ] No color-only meaning; no hover-only information.

## Performance and security

- [ ] Initial route JS ≤ 250KB gzip; module chunk ≤ 120KB gzip.
- [ ] No off-screen sim running; particle caps; canvas DPR ≤ 2.
- [ ] No runtime network calls, tracking, secrets, PII, or `dangerouslySetInnerHTML`.
- [ ] Imported progress JSON validated; external links `rel="noopener noreferrer"`.
- [ ] No console errors or unhandled rejections on crawled routes.

## Release gate

0 type errors, 0 validator errors, all tests pass, build passes, no horizontal overflow at 390px, incidents visible, answers hidden, reviewer sign-off, no duplicate deltas.
