import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createOperationCancellation } from "../cancellable-operation";
import type { CapturedNoteSequence } from "../sequencer/user-sequences";

interface SequenceCommitDialogProps {
  take: CapturedNoteSequence;
  origin: HTMLElement | null;
  onSave: (name: string) => string | null | Promise<string | null>;
  onDiscard: () => void;
}

const formatDuration = (durationMs: number): string => {
  const totalTenths = Math.round(Math.max(0, durationMs) / 100);
  if (totalTenths < 600) return `${(totalTenths / 10).toFixed(1)} sec`;
  const minutes = Math.floor(totalTenths / 600);
  const secondsTenths = totalTenths - minutes * 600;
  return `${minutes}:${(secondsTenths / 10).toFixed(1).padStart(4, "0")}`;
};

export function SequenceCommitDialog({
  take,
  origin,
  onSave,
  onDiscard,
}: SequenceCommitDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const keepButtonRef = useRef<HTMLButtonElement>(null);
  const discardButtonRef = useRef<HTMLButtonElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<"review" | "name">("review");
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submissionRef = useRef(0);
  const cancelSubmissionRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      submissionRef.current += 1;
      const cancelSubmission = cancelSubmissionRef.current;
      cancelSubmissionRef.current = null;
      cancelSubmission?.();
      origin?.focus({ preventScroll: true });
    };
  }, [origin]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (stage === "review") {
        if (take.noteCount > 0) keepButtonRef.current?.focus();
        else discardButtonRef.current?.focus();
      }
      else nameInputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [stage, take.noteCount]);

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || stage !== "name" || take.noteCount === 0) return;
    const submission = ++submissionRef.current;
    const cancellation = createOperationCancellation("Sequence dialog closed during submission.");
    cancelSubmissionRef.current = cancellation.cancel;
    setBusy(true);
    setError("");
    try {
      const result = await cancellation.race(onSave(draftName));
      if (submission !== submissionRef.current) return;
      if (result) {
        setError(result);
        nameInputRef.current?.focus();
      }
    } catch {
      if (submission !== submissionRef.current) return;
      setError("This sequence could not be saved. Try again.");
    } finally {
      if (cancelSubmissionRef.current === cancellation.cancel) cancelSubmissionRef.current = null;
      if (submission === submissionRef.current) setBusy(false);
    }
  };

  const handleEscape = (event: KeyboardEvent<HTMLDialogElement>): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (!busy && stage === "name") {
      setError("");
      setStage("review");
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="direct-entry sequence-commit-dialog"
      aria-labelledby="sequence-commit-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy && stage === "name") {
          setError("");
          setStage("review");
        }
      }}
      onKeyDown={handleEscape}
    >
      <form noValidate aria-busy={busy} onSubmit={(event) => void save(event)}>
        <div className="modal-kicker">Note sequencer</div>
        <h2 id="sequence-commit-title">{stage === "review" ? "Keep this recording?" : "Name sequence"}</h2>

        <p className="modal-current sequence-take-summary">
          {take.noteCount > 0
            ? `${take.noteCount} note${take.noteCount === 1 ? "" : "s"} · ${formatDuration(take.durationMs)}`
            : "No notes were captured."}
        </p>

        {stage === "review" ? (
          <>
            <p className="valid-range">
              Only keyboard note timing was captured. Controls, wheels, pedals, and patch changes were not recorded.
            </p>
            <p className="modal-error" aria-live="polite">
              {take.noteCount === 0 ? "Play at least one note to create a savable sequence." : ""}
            </p>
            <div className="modal-actions sequence-review-actions">
              <button
                ref={discardButtonRef}
                type="button"
                className="button button--danger"
                disabled={busy}
                onClick={onDiscard}
              >
                Discard recording
              </button>
              <button
                ref={keepButtonRef}
                type="button"
                className="button button--primary"
                disabled={busy || take.noteCount === 0}
                onClick={() => setStage("name")}
              >
                Save and name…
              </button>
            </div>
          </>
        ) : (
          <>
            <label htmlFor="sequence-library-name">Sequence name</label>
            <input
              ref={nameInputRef}
              id="sequence-library-name"
              className="patch-name-field"
              type="text"
              autoComplete="off"
              value={draftName}
              readOnly={busy}
              aria-invalid={Boolean(error)}
              aria-describedby="sequence-library-help sequence-library-error"
              onChange={(event) => {
                setDraftName(event.target.value);
                setError("");
              }}
            />
            <p id="sequence-library-help" className="valid-range">
              Leading and trailing whitespace is removed. Names must be unique, regardless of capitalization.
            </p>
            <p id="sequence-library-error" className="modal-error" role="alert">{error}</p>
            <div className="modal-actions">
              <button
                type="button"
                className="button button--quiet"
                disabled={busy}
                onClick={() => {
                  setError("");
                  setStage("review");
                }}
              >
                Back
              </button>
              <button type="submit" className="button button--primary" disabled={busy}>
                {busy ? "Saving…" : "Save sequence"}
              </button>
            </div>
          </>
        )}
      </form>
    </dialog>
  );
}
