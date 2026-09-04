import type { Ref } from "react";

interface SequenceTransportProps {
  sequenceNames: readonly string[];
  activeName: string | null;
  recording: boolean;
  playing: boolean;
  recordButtonRef: Ref<HTMLButtonElement>;
  onSelect: (name: string) => void;
  onRecord: () => void;
  onPlay: () => void;
}

/** Persistent, touch-sized access to the local note-sequence transport. */
export function SequenceTransport({
  sequenceNames,
  activeName,
  recording,
  playing,
  recordButtonRef,
  onSelect,
  onRecord,
  onPlay,
}: SequenceTransportProps) {
  return (
    <div className="sequence-strip" role="group" aria-label="Sequence transport">
      <label htmlFor="sequence-select">Sequence</label>
      <select
        id="sequence-select"
        aria-label="Sequence"
        value={activeName ?? ""}
        disabled={recording}
        onChange={(event) => {
          onSelect(event.target.value);
          // Returning focus to the page makes the computer-note keys usable
          // immediately after a pointer-selected native dropdown option.
          event.currentTarget.blur();
        }}
      >
        <option value="">{sequenceNames.length > 0 ? "No sequence loaded" : "No saved sequences"}</option>
        {sequenceNames.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
      <button
        ref={recordButtonRef}
        type="button"
        className={`button sequence-record-button${recording ? " is-active" : ""}`}
        aria-label={recording ? "Stop recording" : "Start recording"}
        aria-pressed={recording}
        onClick={onRecord}
      >
        <i aria-hidden="true" />
        {recording ? "Stop record" : "Record"}
      </button>
      <button
        type="button"
        className={`button sequence-play-button${playing ? " is-active" : ""}`}
        aria-label={playing ? "Stop sequence" : "Play loaded sequence"}
        aria-pressed={playing}
        disabled={!activeName || recording}
        onClick={onPlay}
      >
        <i aria-hidden="true" />
        {playing ? "Stop" : "Play"}
      </button>
    </div>
  );
}
