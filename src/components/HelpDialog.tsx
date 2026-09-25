import { useEffect, useRef, type MouseEvent } from "react";

interface HelpDialogProps {
  origin: HTMLElement | null;
  onClose: () => void;
}

export function HelpDialog({ origin, onClose }: HelpDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const focusTimer = window.setTimeout(() => {
      titleRef.current?.focus({ preventScroll: true });
      if (dialogRef.current) dialogRef.current.scrollTop = 0;
    }, 0);
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
        <h2 ref={titleRef} id="help-dialog-title" tabIndex={-1} autoFocus>How to play</h2>
        <p id="help-dialog-intro" className="modal-current">Press <strong>Power on</strong>, then use any input below.</p>

        <ul className="help-interface-list">
          <li>
            <strong>Screen keys</strong>
            <span className="surface-ink-glyph">Touch, click, or drag across the piano; PPC pads add bends and vibrato.</span>
          </li>
          <li>
            <strong>Computer keys</strong>
            <span>
              <kbd><span className="surface-ink-glyph">A S D F G H J K L ;</span></kbd>
              <span className="surface-ink-glyph"> play white notes; </span>
              <kbd><span className="surface-ink-glyph">W E T Y U O P</span></kbd>
              <span className="surface-ink-glyph"> play black notes.</span>
            </span>
          </li>
          <li>
            <strong>Keyboard focus</strong>
            <span className="surface-ink-glyph">Click or Tab to a piano key, move with arrows, and play with Space or Enter.</span>
          </li>
          <li>
            <strong>MIDI keyboard</strong>
            <span className="surface-ink-glyph">Choose MIDI below the keys, then Connect MIDI; pitch and modulation wheels are recognized.</span>
          </li>
          <li>
            <strong>Live audio</strong>
            <span className="surface-ink-glyph">Choose Use live input for a mic or audio interface, then hold a key.</span>
          </li>
          <li>
            <strong>Hands-free</strong>
            <span className="surface-ink-glyph">Turn on Auto gate to play without holding a key.</span>
          </li>
          <li>
            <strong>Note sequencer</strong>
            <span className="surface-ink-glyph">Record keyboard notes, save or discard, then Play, Pause/resume, or Stop to rewind. Synth controls stay live.</span>
          </li>
          <li>
            <strong>Exact settings</strong>
            <span className="surface-ink-glyph">Right-click or long-press any parameter to enter its exact value and see its valid range.</span>
          </li>
        </ul>

        <div className="modal-actions">
          <button type="submit" className="button button--primary"><span className="surface-reverse-glyph">Close help</span></button>
        </div>
      </form>
    </dialog>
  );
}
