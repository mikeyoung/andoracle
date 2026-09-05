import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CapturedNoteSequence } from "../sequencer/user-sequences";
import { SequenceCommitDialog } from "./SequenceCommitDialog";
import sequenceCommitDialogSource from "./SequenceCommitDialog.tsx?raw";

const renderDialog = (take: CapturedNoteSequence): string => renderToStaticMarkup(createElement(
  SequenceCommitDialog,
  {
    take,
    origin: null,
    onSave: vi.fn(),
    onReplace: vi.fn(),
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

  it("uses an accessible, cancellable confirmation before replacing a recording", () => {
    const source = sequenceCommitDialogSource;
    const replacementStart = source.indexOf("if (saveConflict)");
    const replacementEnd = source.indexOf("const handleEscape", replacementStart);
    const replacement = source.slice(replacementStart, replacementEnd);

    expect(source).toContain('readonly status: "duplicate"');
    expect(source).toContain("readonly existingSequence: UserNoteSequence");
    expect(source).toContain("export type SequenceSaveOutcome = string | null | SequenceSaveConflict");
    expect(source).toContain("onReplace: (");
    expect(source).toContain("signal: AbortSignal");
    expect(source).toContain('role={saveConflict ? "alertdialog" : undefined}');
    expect(source).toContain('"Replace saved recording?"');
    expect(source).toContain("replaceCancelRef.current?.focus()");
    expect(source).toContain("active.replacementController?.abort(");
    expect(source).toContain('cancelActiveSubmission("Sequence dialog unmounted during submission.")');
    expect(source).toContain("if (busyRef.current || stage !== \"name\"");
    expect(replacementStart).toBeGreaterThanOrEqual(0);
    expect(replacement).toContain("snapshotSequence(saveConflict)");
    expect(replacement).toContain("new AbortController()");
    expect(replacement).toContain("onReplace(expected, controller.signal)");
    expect(replacement).toContain("setSaveConflict(null)");
    expect(replacement).toContain("setNameFocusRequest");

    const confirmation = source.slice(
      source.indexOf(") : saveConflict ? ("),
      source.indexOf(") : (", source.indexOf(") : saveConflict ? (") + 1),
    );
    expect(confirmation).toContain('id="sequence-replace-description"');
    expect(confirmation).toMatch(/>\s*Cancel\s*<\/button>/);
    expect(confirmation).toMatch(/>\s*Replace\s*<\/button>/);
    expect(confirmation).not.toMatch(/ref=\{replaceCancelRef\}[\s\S]*?disabled=\{busy\}[\s\S]*?>\s*Cancel/);

    const cancelStart = source.indexOf("const returnToNameForm");
    const cancelEnd = source.indexOf("useEffect", cancelStart);
    const cancel = source.slice(cancelStart, cancelEnd);
    expect(cancel).toContain("cancelActiveSubmission(message)");
    expect(cancel).toContain("setSaveConflict(null)");
    expect(cancel).toContain("setNameFocusRequest");
    expect(cancel).not.toContain("setDraftName");
    expect(cancel).not.toContain("onDiscard");
    expect(source).toMatch(/if \(saveConflict\) \{\s*returnToNameForm\(\);\s*\} else if/);
  });
});
