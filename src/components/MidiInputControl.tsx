import type { MidiInputSummary } from "../midi/web-midi";

interface MidiInputControlProps {
  supported: boolean;
  unsupportedReason: string | null;
  enabled: boolean;
  busy: boolean;
  error: string | null;
  inputs: readonly MidiInputSummary[];
  onToggle: () => void;
  onRefresh: () => void;
}

export function MidiInputControl({
  supported,
  unsupportedReason,
  enabled,
  busy,
  error,
  inputs,
  onToggle,
  onRefresh,
}: MidiInputControlProps) {
  const inputNames = inputs.map((input) => input.name).join(", ");
  const status = error
    ? error
    : !supported
    ? `${unsupportedReason ?? "Web MIDI is unavailable."} Touch and computer keys still work.`
    : !enabled
      ? "Connect a USB or Bluetooth MIDI keyboard. All detected inputs are monitored; notes, pitch bend, and modulation are supported."
      : inputs.length === 0
        ? "MIDI access is on. Connect or switch on a keyboard, then refresh if needed."
        : `${inputs.length} MIDI input${inputs.length === 1 ? "" : "s"}: ${inputNames}`;

  return (
    <section className="midi-strip" aria-label="MIDI keyboard connection">
      <div className="midi-strip-copy">
        <span className="module-eyebrow">Later-model interface · retrofit</span>
        <strong>MIDI keyboard control</strong>
        <small className={error ? "control-error" : undefined} role={error ? "alert" : undefined} aria-live="polite">{status}</small>
      </div>
      <div className="midi-strip-actions">
        {enabled && (
          <button type="button" className="button button--quiet" disabled={busy} onClick={onRefresh}>
            Refresh
          </button>
        )}
        <button
          type="button"
          className={`button${enabled ? " button--midi-on" : " button--primary"}`}
          aria-pressed={enabled}
          disabled={!supported}
          onClick={onToggle}
        >
          {busy ? "Cancel MIDI" : enabled ? "Disconnect MIDI" : "Connect MIDI"}
        </button>
      </div>
    </section>
  );
}
