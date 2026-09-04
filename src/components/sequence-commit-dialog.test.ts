import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CapturedNoteSequence } from "../sequencer/user-sequences";
import { SequenceCommitDialog } from "./SequenceCommitDialog";

const renderDialog = (take: CapturedNoteSequence): string => renderToStaticMarkup(createElement(
  SequenceCommitDialog,
  {
    take,
    origin: null,
    onSave: vi.fn(),
    onDiscard: vi.fn(),
  },
));

describe("SequenceCommitDialog", () => {
  it("offers explicit non-silent save and discard choices for a captured take", () => {
    const markup = renderDialog({
      events: [
        { deltaMs: 0, note: 60, on: true },
        { deltaMs: 1_250, note: 60, on: false },
      ],
      durationMs: 1_250,
      noteCount: 1,
    });
    expect(markup).toContain('aria-labelledby="sequence-commit-title"');
    expect(markup).toContain("Keep this recording?");
    expect(markup).toContain("1 note · 1.3 sec");
    expect(markup).toContain("Discard recording");
    expect(markup).toContain("Save and name…");
    expect(markup).toContain("Controls, wheels, pedals, and patch changes were not recorded.");
  });

  it("prevents an empty take from entering the save flow", () => {
    const markup = renderDialog({ events: [], durationMs: 0, noteCount: 0 });
    expect(markup).toContain("No notes were captured.");
    expect(markup).toContain("Play at least one note to create a savable sequence.");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Save and name…<\/button>/);
  });

  it("formats long recordings without imposing a duration ceiling", () => {
    const markup = renderDialog({
      events: [
        { deltaMs: 0, note: 0, on: true },
        { deltaMs: 7_200_123, note: 0, on: false },
      ],
      durationMs: 7_200_123,
      noteCount: 1,
    });
    expect(markup).toContain("120:00.1");
  });

  it("carries rounded seconds into the next minute", () => {
    const markup = renderDialog({
      events: [
        { deltaMs: 0, note: 60, on: true },
        { deltaMs: 119_999, note: 60, on: false },
      ],
      durationMs: 119_999,
      noteCount: 1,
    });
    expect(markup).toContain("2:00.0");
    expect(markup).not.toContain("1:60.0");
  });
});
