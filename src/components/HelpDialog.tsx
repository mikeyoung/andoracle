import { useEffect, useRef, type MouseEvent } from "react";

interface HelpDialogProps {
  origin: HTMLElement | null;
  onClose: () => void;
}

export function HelpDialog({ origin, onClose }: HelpDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(focusTimer);
      origin?.focus({ preventScroll: true });
    };
  }, [origin]);

  const backdropClose = (event: MouseEvent<HTMLDialogElement>): void => {
    if (event.target === dialogRef.current) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="direct-entry help-dialog"
      aria-labelledby="help-dialog-title"
      aria-describedby="help-dialog-intro"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onClick={backdropClose}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <div className="modal-kicker">Andoracle quick start</div>
        <h2 id="help-dialog-title">How to play</h2>
        <p id="help-dialog-intro" className="modal-current">Press <strong>Power on</strong>, then use any input below.</p>

        <ul className="help-interface-list">
          <li>
            <strong>Screen keys</strong>
            <span>Touch, click, or drag across the piano; PPC pads add bends and vibrato.</span>
          </li>
          <li>
            <strong>Computer keys</strong>
            <span><kbd>A S D F G H J K L ;</kbd> play white notes; <kbd>W E T Y U O P</kbd> play black notes.</span>
          </li>
          <li>
            <strong>Keyboard focus</strong>
            <span>Click or Tab to a piano key, move with arrows, and play with Space or Enter.</span>
          </li>
          <li>
            <strong>MIDI keyboard</strong>
            <span>Choose Connect MIDI and play; pitch and modulation wheels are recognized.</span>
          </li>
          <li>
            <strong>Live audio</strong>
            <span>Choose Use live input for a mic or audio interface, then hold a key.</span>
          </li>
          <li>
            <strong>Hands-free</strong>
            <span>Turn on Auto gate to play without holding a key.</span>
          </li>
          <li>
            <strong>Note sequencer</strong>
            <span>Record keyboard notes, save or discard, then Play, Pause/resume, or Stop to rewind. Synth controls stay live.</span>
          </li>
        </ul>

        <div className="modal-actions">
          <button ref={closeButtonRef} type="submit" className="button button--primary">Close help</button>
        </div>
      </form>
    </dialog>
  );
}
