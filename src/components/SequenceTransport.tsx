import { memo, useEffect, useRef, type Ref } from "react";
import { DeferredSelectFocusRelease, type SelectInteractionModality } from "./select-focus";
import { RasterLabel } from "./RasterLabel";

export type SequencePlaybackState = "stopped" | "starting" | "playing" | "paused";

interface SequenceTransportProps {
  sequenceNames: readonly string[];
  activeName: string | null;
  recording: boolean;
  playbackState: SequencePlaybackState;
  recordButtonRef: Ref<HTMLButtonElement>;
  onSelect: (name: string) => void;
  onRecord: () => void;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onDelete: (origin: HTMLButtonElement) => void;
}

/** Persistent, touch-sized access to the local note-sequence transport. */
function SequenceTransportComponent({
  sequenceNames,
  activeName,
  recording,
  playbackState,
  recordButtonRef,
  onSelect,
  onRecord,
  onPlay,
  onPause,
  onStop,
  onDelete,
}: SequenceTransportProps) {
  const playing = playbackState === "playing";
  const starting = playbackState === "starting";
  const paused = playbackState === "paused";
  const playbackActive = starting || playing || paused;
  const playButtonRef = useRef<HTMLButtonElement>(null);
  const selectInteractionModality = useRef<SelectInteractionModality>("keyboard");
  const selectFocusRelease = useRef<DeferredSelectFocusRelease | null>(null);
  selectFocusRelease.current ??= new DeferredSelectFocusRelease();
  useEffect(() => () => selectFocusRelease.current?.dispose(), []);
  const returnFocusToPlay = (): void => {
    queueMicrotask(() => playButtonRef.current?.focus({ preventScroll: true }));
  };

  return (
    <div
      className="sequence-strip"
      role="group"
      aria-label="Sequence transport"
      aria-busy={starting || undefined}
    >
      <div className="library-picker sequence-picker">
        <label htmlFor="sequence-select"><RasterLabel text="Sequence" variant="control" /></label>
        <div className="library-select-shell">
          <select
            id="sequence-select"
            aria-label="Sequence"
            value={activeName ?? ""}
            disabled={recording}
            onPointerDown={() => {
              selectFocusRelease.current?.dispose();
              selectInteractionModality.current = "pointer";
            }}
            onKeyDown={(event) => {
              if (selectFocusRelease.current?.hasPointerFocusReleasePending) return;
              if (selectInteractionModality.current === "pointer" && event.key === "Escape") {
                selectFocusRelease.current?.finish(event.currentTarget, "pointer");
                return;
              }
              selectFocusRelease.current?.dispose();
              selectInteractionModality.current = "keyboard";
            }}
            onClick={(event) => {
              if (selectInteractionModality.current === "pointer") {
                selectFocusRelease.current?.watchPointerPicker(event.currentTarget);
              }
            }}
            onChange={(event) => {
              onSelect(event.target.value);
              selectFocusRelease.current?.finish(
                event.currentTarget,
                selectInteractionModality.current,
              );
              selectInteractionModality.current = "keyboard";
            }}
          >
            <option value="">{sequenceNames.length > 0 ? "None loaded" : "No sequences"}</option>
            {sequenceNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
      </div>
      <div className="library-actions sequence-actions">
        <button
          ref={recordButtonRef}
          type="button"
          className={`button sequence-icon-button sequence-record-button${recording ? " is-active" : ""}`}
          aria-label={recording ? "Stop recording" : "Start recording"}
          title={recording ? "Stop recording" : "Start recording"}
          aria-pressed={recording}
          onClick={onRecord}
        >
          <i aria-hidden="true" />
        </button>
        <button
          ref={playButtonRef}
          type="button"
          className={`button sequence-icon-button sequence-play-button${playing ? " is-active" : ""}`}
          aria-label={starting ? "Starting sequence" : paused ? "Resume sequence" : "Play loaded sequence"}
          title={starting ? "Starting sequence" : paused ? "Resume sequence" : "Play loaded sequence"}
          aria-pressed={playing}
          disabled={!activeName || recording || starting || playing}
          onClick={onPlay}
        >
          <i aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`button sequence-icon-button sequence-pause-button${paused ? " is-active" : ""}`}
          aria-label="Pause sequence"
          title="Pause sequence"
          aria-pressed={paused}
          disabled={!activeName || recording || !playing}
          onClick={() => {
            onPause();
            returnFocusToPlay();
          }}
        >
          <i aria-hidden="true" />
        </button>
        <button
          type="button"
          className="button sequence-icon-button sequence-stop-button"
          aria-label="Stop sequence and return to beginning"
          title="Stop sequence and return to beginning"
          disabled={!activeName || recording || !playbackActive}
          onClick={() => {
            onStop();
            returnFocusToPlay();
          }}
        >
          <i aria-hidden="true" />
        </button>
        <button
          type="button"
          className="button button--danger sequence-icon-button sequence-delete-button"
          aria-label="Delete active recording"
          title="Delete active recording"
          aria-haspopup="dialog"
          disabled={!activeName || recording}
          onClick={(event) => onDelete(event.currentTarget)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 10v7m4-7v7" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export const SequenceTransport = memo(SequenceTransportComponent);
