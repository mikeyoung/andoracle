import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SequenceTransport } from "./SequenceTransport";

const renderTransport = (overrides: Partial<Parameters<typeof SequenceTransport>[0]> = {}): string => (
  renderToStaticMarkup(createElement(SequenceTransport, {
    sequenceNames: [],
    activeName: null,
    recording: false,
    playing: false,
    recordButtonRef: null,
    onSelect: vi.fn(),
    onRecord: vi.fn(),
    onPlay: vi.fn(),
    ...overrides,
  }))
);

describe("SequenceTransport", () => {
  it("always renders labelled Record and Play controls at the top-level transport", () => {
    const markup = renderTransport();
    expect(markup).toContain('role="group" aria-label="Sequence transport"');
    expect(markup).toContain('<label for="sequence-select">Sequence</label>');
    expect(markup).toContain('id="sequence-select"');
    expect(markup).toContain('aria-label="Start recording" aria-pressed="false"');
    expect(markup).toContain('aria-label="Play loaded sequence" aria-pressed="false" disabled=""');
    expect(markup).toContain("No saved sequences");
  });

  it("renders saved names without colliding with the empty sentinel", () => {
    const markup = renderTransport({
      sequenceNames: ["No saved sequences", "  visual spaces  "],
      activeName: "No saved sequences",
    });
    expect(markup).toContain('<option value="">No sequence loaded</option>');
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
    expect(markup).toContain('aria-label="Play loaded sequence" aria-pressed="false" disabled=""');
  });

  it("turns Play into an explicit Stop control during playback", () => {
    const markup = renderTransport({
      sequenceNames: ["Take one"],
      activeName: "Take one",
      playing: true,
    });
    expect(markup).toContain('sequence-play-button is-active');
    expect(markup).toContain('aria-label="Stop sequence" aria-pressed="true"');
    expect(markup).toContain(">Stop</button>");
    expect(markup).not.toContain('aria-label="Stop sequence" aria-pressed="true" disabled');
  });
});
