import { memo, useId } from "react";
import type { MidiInputSummary } from "../midi/web-midi";
import { PanelScrews } from "./PanelScrews";

export type MidiInputOperation = "connecting" | "refreshing" | "disconnecting" | "cancelling" | null;

export const midiInputDisplayName = (input: MidiInputSummary): string => {
  const name = input.name.trim() || "MIDI input";
  const manufacturer = input.manufacturer.trim();
  return manufacturer && !name.toLowerCase().includes(manufacturer.toLowerCase())
    ? `${name} (${manufacturer})`
    : name;
};

export const midiInputListLabel = (inputs: readonly MidiInputSummary[]): string => (
  inputs.map(midiInputDisplayName).join(", ")
);

interface MidiInputControlProps {
  supported: boolean;
  unsupportedReason: string | null;
  enabled: boolean;
  operation: MidiInputOperation;
  error: string | null;
  inputs: readonly MidiInputSummary[];
  onToggle: () => void;
  onRefresh: () => void;
}

function MidiInputControlComponent({
  supported,
  unsupportedReason,
  enabled,
  operation,
  error,
  inputs,
  onToggle,
  onRefresh,
}: MidiInputControlProps) {
  const titleId = useId();
  const statusId = useId();
  const busy = operation !== null;
  const inputNames = midiInputListLabel(inputs);
  const connectedStatus = `${inputs.length} MIDI input${inputs.length === 1 ? "" : "s"}: ${inputNames}`;
  const operationStatus = operation === "connecting"
    ? "Waiting for MIDI permission and opening detected inputs."
    : operation === "refreshing"
      ? "Refreshing detected MIDI inputs."
      : operation === "disconnecting"
        ? "Disconnecting MIDI inputs."
        : operation === "cancelling"
          ? "Cancelling the MIDI operation and disconnecting inputs."
          : null;
  const status = error
    ? inputs.length > 0 ? `${error} — active ${connectedStatus}.` : error
    : operationStatus
      ? operationStatus
    : !supported
    ? `${unsupportedReason ?? "Web MIDI is unavailable."} Touch and computer keys still work.`
    : !enabled
      ? "Connect a USB or Bluetooth MIDI keyboard. All detected inputs are monitored; notes, pitch bend, and modulation are supported."
      : inputs.length === 0
        ? "MIDI access is on. Connect or switch on a keyboard, then refresh if needed."
        : connectedStatus;
  const cancellationAvailable = operation === "connecting" || operation === "refreshing";
  const actionLabel = cancellationAvailable
    ? "Cancel MIDI"
    : operation === "disconnecting"
      ? "Disconnecting…"
      : operation === "cancelling"
        ? "Cancelling…"
        : enabled ? "Disconnect MIDI" : "Connect MIDI";

  return (
    <section className="midi-strip"
      aria-labelledby={titleId}
      aria-describedby={statusId}
      aria-busy={busy}
    >
      <PanelScrews />
      <div className="midi-strip-copy">
        <span className="module-eyebrow">Later-model interface · retrofit</span>
        <strong id={titleId}>MIDI keyboard control</strong>
        <small
          id={statusId}
          className={error ? "control-error" : undefined}
          role={error ? "alert" : "status"}
          aria-live={error ? "assertive" : "polite"}
          aria-atomic="true"
        >
          {status}
        </small>
      </div>
      <div className="midi-strip-actions">
        {enabled && (
          <button
            key="refresh"
            type="button"
            className="button button--quiet"
            aria-describedby={statusId}
            aria-disabled={busy || undefined}
            onClick={busy ? undefined : onRefresh}
          >
            Refresh
          </button>
        )}
        <button
          key="toggle"
          type="button"
          className={`button${enabled ? " button--midi-on" : " button--primary"}`}
          aria-pressed={enabled}
          aria-describedby={statusId}
          aria-disabled={operation === "disconnecting" || operation === "cancelling" || undefined}
          disabled={!supported}
          onClick={operation === "disconnecting" || operation === "cancelling" ? undefined : onToggle}
        >
          {actionLabel}
        </button>
      </div>
    </section>
  );
}

export const MidiInputControl = memo(MidiInputControlComponent);
