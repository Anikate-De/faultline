import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { CaseFileView } from "@/case-files/CaseStudyView";
import { caseStudy } from "@/case-files/composite-retry-storm/case";
import { meta } from "@/case-files/composite-retry-storm/meta";
import { hasAuthoredCase, loadCaseFile } from "@/case-files/registry";
import CaseFile from "@/routes/CaseFile";

describe("composite case file", () => {
  it("loads the authored exemplar through the case registry", async () => {
    expect(hasAuthoredCase("composite-retry-storm")).toBe(true);
    const loaded = await loadCaseFile("composite-retry-storm");
    expect(loaded.meta.id).toBe("case-composite-retry-storm");
    expect(loaded.caseStudy.kind).toBe("composite");
  });

  it("labels a composite and shows company, date, and incident class", () => {
    render(<CaseFileView meta={meta} study={caseStudy} />);
    expect(screen.getByText("Composite scenario — not a real incident.")).toBeInTheDocument();
    expect(screen.getByText("Company")).toBeInTheDocument();
    expect(screen.getByText(caseStudy.company)).toBeInTheDocument();
    expect(screen.getByText(caseStudy.date)).toBeInTheDocument();
    expect(screen.getByText(caseStudy.incidentClass)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(meta.title);
  });

  it("hides a decision debrief until the learner reveals it", async () => {
    render(<CaseFileView meta={meta} study={caseStudy} />);
    const first = caseStudy.decisions[0];
    expect(screen.queryByText(first.debrief)).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Reveal" })[0]);
    expect(screen.getByText(first.debrief)).toBeInTheDocument();
  });

  it("reveals the consequence of the chosen option only", async () => {
    render(<CaseFileView meta={meta} study={caseStudy} />);
    const first = caseStudy.decisions[0];
    const option = first.options[0];
    expect(screen.queryByText(option.consequence)).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("radio")[0]);
    expect(screen.getByText(option.consequence)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: new RegExp(option.label) })).toHaveAttribute("aria-checked", "true");
  });

  it("renders timeline, postmortem, and sources", () => {
    render(<CaseFileView meta={meta} study={caseStudy} />);
    expect(screen.getByRole("heading", { name: "Timeline" })).toBeInTheDocument();
    for (const event of caseStudy.timeline) {
      expect(screen.getByText(event.title)).toBeInTheDocument();
    }
    expect(screen.getByRole("heading", { name: "Postmortem" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What generalizes" })).toBeInTheDocument();
    const sources = screen.getByRole("heading", { name: "Sources" }).closest("section");
    expect(sources).not.toBeNull();
    for (const source of caseStudy.sources) {
      expect(within(sources as HTMLElement).getByRole("link", { name: new RegExp(source.title) })).toBeInTheDocument();
    }
  });

  it("renders authored composite and public routes", async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={["/case-files/composite-retry-storm"]}>
        <Routes>
          <Route path="/case-files/:slug" element={<CaseFile />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { level: 1, name: meta.title })).toBeInTheDocument();
    expect(await screen.findByText("Composite scenario — not a real incident.")).toBeInTheDocument();
    unmount();

    render(
      <MemoryRouter initialEntries={["/case-files/github-2018"]}>
        <Routes>
          <Route path="/case-files/:slug" element={<CaseFile />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: /GitHub 2018/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Public incident")).toBeInTheDocument();
    expect(screen.queryByText("Composite scenario — not a real incident.")).not.toBeInTheDocument();
  });
});
