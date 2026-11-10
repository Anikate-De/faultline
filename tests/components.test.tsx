import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RevealPanel, PredictionPicker } from "@/components/ui/Reveal";
import { InterviewQuestion } from "@/components/interview/InterviewQuestion";
import { ConfidencePicker } from "@/components/interview/InterviewQuestion";
import { BlockRenderer } from "@/components/content/Blocks";
import { ErrorBoundary } from "@/components/ui/Feedback";
import { useAppStore } from "@/lib/store";
import type { InterviewQuestion as InterviewQuestionType } from "@/content/types";

const question: InterviewQuestionType = {
  id: "q",
  question: "What signal shows the hot shard?",
  difficulty: 2,
  hints: ["Think per shard."],
  answer: "Per-shard CPU and p99 reveal the concentration.",
  followUps: ["What next?"],
  redFlags: ["Uses the average."],
  rubric: ["Names per-shard evidence."],
};

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({
    completed: {},
    confidence: {},
    bookmarks: [],
    reviews: {},
    lastModule: null,
    recentSearches: [],
  });
});

describe("answer hiding", () => {
  it("does not render reveal content until asked", async () => {
    render(
      <RevealPanel label="Model answer">
        <p>Hidden explanation</p>
      </RevealPanel>,
    );
    expect(screen.queryByText("Hidden explanation")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /reveal/i }));
    expect(screen.getByText("Hidden explanation")).toBeInTheDocument();
  });

  it("hides prediction feedback until revealed", () => {
    const { rerender } = render(
      <PredictionPicker
        question="Which shard?"
        options={[{ id: "hot", label: "Hot shard" }, { id: "all", label: "All shards" }, { id: "db", label: "Database" }]}
        value="hot"
        onChange={() => undefined}
        correctId="hot"
        revealed={false}
        explanation="The hot key maps to one slot."
      />,
    );
    expect(screen.queryByText("The hot key maps to one slot.")).not.toBeInTheDocument();
    rerender(
      <PredictionPicker
        question="Which shard?"
        options={[{ id: "hot", label: "Hot shard" }, { id: "all", label: "All shards" }, { id: "db", label: "Database" }]}
        value="hot"
        onChange={() => undefined}
        correctId="hot"
        revealed
        explanation="The hot key maps to one slot."
      />,
    );
    expect(screen.getByText("The hot key maps to one slot.")).toBeInTheDocument();
  });

  it("hides the interview model answer in the DOM", async () => {
    render(<InterviewQuestion question={question} index={0} />);
    expect(screen.queryByText(question.answer)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /reveal/i }));
    expect(screen.getByText(question.answer)).toBeInTheDocument();
  });
});

describe("learning state", () => {
  it("records confidence and schedules a review", async () => {
    render(<ConfidencePicker moduleId="caching-hot-key-sharding" />);
    await userEvent.click(screen.getByRole("button", { name: /Confidence 4 of 5/ }));
    expect(useAppStore.getState().confidence["caching-hot-key-sharding"]).toBe(4);
    expect(useAppStore.getState().reviews["caching-hot-key-sharding"]).toBeTruthy();
  });
});

describe("content rendering", () => {
  it("renders typed text without executing raw HTML", () => {
    render(<BlockRenderer blocks={[{ type: "p", text: "<script>alert(1)</script> and **bold**" }]} />);
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText(/alert\(1\)/)).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
  });

  it("opens external links safely", () => {
    render(<BlockRenderer blocks={[{ type: "p", text: "[docs](https://redis.io/docs/)" }]} />);
    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});

describe("error boundary", () => {
  it("catches a render failure", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Crash(): never {
      throw new Error("boom");
    }
    render(
      <ErrorBoundary fallback={<p>caught</p>}>
        <Crash />
      </ErrorBoundary>,
    );
    expect(screen.getByText("caught")).toBeInTheDocument();
    spy.mockRestore();
  });
});
