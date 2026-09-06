import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SequenceTransport } from "./SequenceTransport";

const renderTransport = (overrides: Partial<Parameters<typeof SequenceTransport>[0]> = {}): string => (
  renderToStaticMarkup(createElement(SequenceTransport, {
    sequenceNames: [],
    activeName: null,
    recording: false,
    playbackState: "stopped",
    recordButtonRef: null,
    onSelect: vi.fn(),
    onRecord: vi.fn(),
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onStop: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  }))
);

const buttonTag = (markup: string, label: string): string => {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return markup.match(new RegExp(`<button[^>]*aria-label="${escaped}"[^>]*>`))?.[0] ?? "";
};

const buttonMarkup = (markup: string, label: string): string => {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return markup.match(new RegExp(`<button[^>]*aria-label="${escaped}"[^>]*>[\\s\\S]*?</button>`))?.[0] ?? "";
};

describe("SequenceTransport", () => {
  it("always renders labelled Record, Play, Pause, Stop, and Delete controls", () => {
    const markup = renderTransport();
    expect(markup).toContain('role="group" aria-label="Sequence transport"');
    expect(markup).toContain('<label for="sequence-select">Sequence</label>');
    expect(markup).toContain('id="sequence-select"');
    expect(markup).toContain('aria-label="Start recording" aria-pressed="false"');
    expect(buttonTag(markup, "Play loaded sequence")).toContain('aria-pressed="false"');
    expect(buttonTag(markup, "Play loaded sequence")).toContain("disabled");
    expect(buttonTag(markup, "Pause sequence")).toContain('aria-pressed="false"');
    expect(buttonTag(markup, "Pause sequence")).toContain("disabled");
    expect(buttonTag(markup, "Stop sequence and return to beginning")).toContain("disabled");
    expect(buttonTag(markup, "Delete active recording")).toContain('aria-haspopup="dialog"');
    expect(buttonTag(markup, "Delete active recording")).toContain("disabled");
    expect(markup).toContain("No sequences");
  });

  it("uses icon-only Play, Pause, Stop, and trash controls with accessible names", () => {
    const markup = renderTransport();
    const play = buttonMarkup(markup, "Play loaded sequence");
    const pause = buttonMarkup(markup, "Pause sequence");
    const stop = buttonMarkup(markup, "Stop sequence and return to beginning");
    const remove = buttonMarkup(markup, "Delete active recording");

    expect(play).toMatch(/<i aria-hidden="true"><\/i><\/button>$/);
    expect(pause).toMatch(/<i aria-hidden="true"><\/i><\/button>$/);
    expect(stop).toMatch(/<i aria-hidden="true"><\/i><\/button>$/);
    expect(remove).toContain('<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">');
    expect(remove).not.toMatch(/>\s*Delete\s*</);
    expect(markup).toContain("Record</button>");
  });

  it("renders saved names without colliding with the empty sentinel", () => {
    const markup = renderTransport({
      sequenceNames: ["No saved sequences", "  visual spaces  "],
      activeName: "No saved sequences",
    });
    expect(markup).toContain('<option value="">None loaded</option>');
    expect(markup).toContain('<option value="No saved sequences" selected="">No saved sequences</option>');
    expect(markup).toContain('<option value="  visual spaces  ">  visual spaces  </option>');
  });

  it("exposes recording state in text and ARIA while preventing selection or playback", () => {
    const markup = renderTransport({
      sequenceNames: ["Take one"],
      activeName: "Take one",
      recording: true,
    });
    expect(markup).toContain('id="sequence-select" aria-label="Sequence" disabled=""');
    expect(markup).toContain('sequence-record-button is-active');
    expect(markup).toContain('aria-label="Stop recording" aria-pressed="true"');
    expect(markup).toContain("Stop record");
    expect(buttonTag(markup, "Play loaded sequence")).toContain('aria-pressed="false"');
    expect(buttonTag(markup, "Play loaded sequence")).toContain("disabled");
    expect(buttonTag(markup, "Pause sequence")).toContain('aria-pressed="false"');
    expect(buttonTag(markup, "Pause sequence")).toContain("disabled");
    expect(buttonTag(markup, "Stop sequence and return to beginning")).toContain("disabled");
    expect(buttonTag(markup, "Delete active recording")).toContain("disabled");
  });

  it("enables only Play when a sequence is loaded but stopped", () => {
    const markup = renderTransport({
      sequenceNames: ["Take one"],
      activeName: "Take one",
    });
    expect(buttonTag(markup, "Play loaded sequence")).not.toContain("disabled");
    expect(buttonTag(markup, "Pause sequence")).toContain("disabled");
    expect(buttonTag(markup, "Stop sequence and return to beginning")).toContain("disabled");
    expect(buttonTag(markup, "Delete active recording")).not.toContain("disabled");
  });

  it("keeps separate Pause and Stop actions during playback", () => {
    const markup = renderTransport({
      sequenceNames: ["Take one"],
      activeName: "Take one",
      playbackState: "playing",
    });
    expect(markup).toContain('sequence-play-button is-active');
    expect(buttonTag(markup, "Play loaded sequence")).toContain("disabled");
    expect(buttonTag(markup, "Pause sequence")).not.toContain("disabled");
    expect(buttonTag(markup, "Stop sequence and return to beginning")).not.toContain("disabled");
    expect(buttonTag(markup, "Delete active recording")).not.toContain("disabled");
    expect(markup).not.toContain('aria-label="Stop sequence"');
  });

  it("offers Play-as-Resume, shows Pause as active, and keeps Stop available while paused", () => {
    const markup = renderTransport({
      sequenceNames: ["Take one"],
      activeName: "Take one",
      playbackState: "paused",
    });
    expect(buttonTag(markup, "Resume sequence")).not.toContain("disabled");
    expect(markup).toContain('sequence-pause-button is-active');
    expect(buttonTag(markup, "Pause sequence")).toContain("disabled");
    expect(buttonTag(markup, "Pause sequence")).toContain('aria-pressed="true"');
    expect(buttonTag(markup, "Pause sequence")).toContain("disabled");
    expect(buttonTag(markup, "Stop sequence and return to beginning")).not.toContain("disabled");
    expect(buttonTag(markup, "Delete active recording")).not.toContain("disabled");
  });
});
