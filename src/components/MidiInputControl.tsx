import { memo, useEffect, useId, useRef, useState, type MouseEvent } from "react";
import type { MidiInputSummary } from "../midi/web-midi";
import { RasterLabel } from "./RasterLabel";

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
  const launcherRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [open, setOpen] = useState(false);
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

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const focusTimer = window.setTimeout(() => titleRef.current?.focus({ preventScroll: true }), 0);
    return () => {
      window.clearTimeout(focusTimer);
      if (dialog?.open) dialog.close();
      launcherRef.current?.focus({ preventScroll: true });
    };
  }, [open]);

  const backdropClose = (event: MouseEvent<HTMLDialogElement>): void => {
    if (event.target === dialogRef.current) setOpen(false);
  };

  return (
    <div className="midi-control" aria-busy={busy}>
      <button
        ref={launcherRef}
        type="button"
        className={`button button--quiet midi-control__launcher${enabled ? " is-enabled" : ""}${error ? " has-error" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`MIDI keyboard controls. ${status}`}
        onClick={() => setOpen(true)}
      >
        <i className="midi-control__lamp" aria-hidden="true" />
        <RasterLabel text="MIDI" variant="button" tone="reverse" />
      </button>

      <dialog
        ref={dialogRef}
        className="direct-entry midi-dialog"
        aria-labelledby={titleId}
        aria-describedby={statusId}
        aria-busy={busy}
        onCancel={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }}
        onClick={backdropClose}
      >
        <form
          method="dialog"
          onSubmit={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
        >
          <div className="modal-kicker">Later-model interface · retrofit</div>
          <h2 ref={titleRef} id={titleId} tabIndex={-1}>MIDI keyboard control</h2>
          <p
            id={statusId}
            className={`modal-current midi-dialog__status${error ? " control-error" : ""}`}
            role={error ? "alert" : "status"}
            aria-live={error ? "assertive" : "polite"}
            aria-atomic="true"
          >
            {status}
          </p>
          <div className="modal-actions midi-dialog__actions">
            {enabled && (
              <button
                key="refresh"
                type="button"
                className="button button--quiet"
                aria-describedby={statusId}
                aria-disabled={busy || undefined}
                onClick={busy ? undefined : onRefresh}
              >
                <RasterLabel text="Refresh" variant="button" tone="reverse" />
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
              <RasterLabel text={actionLabel} variant="button" tone="reverse" />
            </button>
            <button
              type="submit"
              className="button button--quiet"
            >
              <RasterLabel text="Close" variant="button" tone="reverse" />
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

export const MidiInputControl = memo(MidiInputControlComponent);
