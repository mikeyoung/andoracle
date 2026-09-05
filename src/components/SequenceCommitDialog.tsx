import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  LIBRARY_WRITE_TIMEOUT_MS,
  createOperationCancellation,
} from "../cancellable-operation";
import {
  USER_SEQUENCE_NAME_MAX_LENGTH,
  type CapturedNoteSequence,
  type UserNoteSequence,
} from "../sequencer/user-sequences";
import { truncateUserLibraryName } from "../user-library-name";

export interface SequenceSaveConflict {
  readonly status: "duplicate";
  readonly existingSequence: UserNoteSequence;
}

export type SequenceSaveOutcome = string | null | SequenceSaveConflict;

interface SequenceCommitDialogProps {
  take: CapturedNoteSequence;
  origin: HTMLElement | null;
  onSave: (
    name: string,
    signal: AbortSignal,
  ) => SequenceSaveOutcome | Promise<SequenceSaveOutcome>;
  onReplace: (
    expected: UserNoteSequence,
    signal: AbortSignal,
  ) => string | null | Promise<string | null>;
  onDiscard: () => void;
}

interface ActiveSubmission {
  readonly id: number;
  readonly cancelWait: () => void;
  readonly replacementController: AbortController | null;
  timeoutId: number | null;
}

const snapshotSequence = (sequence: UserNoteSequence): UserNoteSequence => ({
  name: sequence.name,
  data: sequence.data,
  durationMs: sequence.durationMs,
  noteCount: sequence.noteCount,
  eventCount: sequence.eventCount,
});

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
  onReplace,
  onDiscard,
}: SequenceCommitDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const keepButtonRef = useRef<HTMLButtonElement>(null);
  const discardButtonRef = useRef<HTMLButtonElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const replaceCancelRef = useRef<HTMLButtonElement>(null);
  const [stage, setStage] = useState<"review" | "name">("review");
  const [draftName, setDraftName] = useState("");
  const [saveConflict, setSaveConflict] = useState<UserNoteSequence | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const submissionRef = useRef(0);
  const activeSubmissionRef = useRef<ActiveSubmission | null>(null);
  const [nameFocusRequest, setNameFocusRequest] = useState(0);

  const cancelActiveSubmission = (message: string): void => {
    const active = activeSubmissionRef.current;
    if (!active) return;
    activeSubmissionRef.current = null;
    submissionRef.current += 1;
    if (active.timeoutId !== null) {
      window.clearTimeout(active.timeoutId);
      active.timeoutId = null;
    }
    active.cancelWait();
    active.replacementController?.abort(new DOMException(message, "AbortError"));
    busyRef.current = false;
  };

  const releaseSubmission = (active: ActiveSubmission): boolean => {
    if (activeSubmissionRef.current !== active || active.id !== submissionRef.current) return false;
    activeSubmissionRef.current = null;
    if (active.timeoutId !== null) {
      window.clearTimeout(active.timeoutId);
      active.timeoutId = null;
    }
    busyRef.current = false;
    return true;
  };

  const beginSubmission = (replacementController: AbortController | null): {
    readonly active: ActiveSubmission;
    readonly race: <T>(operation: T | PromiseLike<T>) => Promise<T>;
  } => {
    busyRef.current = true;
    const cancellation = createOperationCancellation("Sequence dialog closed during submission.");
    const active: ActiveSubmission = {
      id: ++submissionRef.current,
      cancelWait: cancellation.cancel,
      replacementController,
      timeoutId: null,
    };
    activeSubmissionRef.current = active;
    active.timeoutId = window.setTimeout(() => {
      if (activeSubmissionRef.current !== active) return;
      const action = saveConflict ? "replacement" : "save";
      cancelActiveSubmission(`Recording ${action} timed out.`);
      setBusy(false);
      if (saveConflict) setSaveConflict(null);
      setError(`Recording ${action} timed out and may already have completed. Retrying this name is safe; Andoracle asks before any replacement.`);
      setNameFocusRequest((request) => request + 1);
    }, LIBRARY_WRITE_TIMEOUT_MS);
    setBusy(true);
    setError("");
    return { active, race: cancellation.race };
  };

  const returnToNameForm = (message = "Recording replacement cancelled."): void => {
    const outcomeUncertain = busyRef.current;
    cancelActiveSubmission(message);
    busyRef.current = false;
    setBusy(false);
    setSaveConflict(null);
    setError(outcomeUncertain
      ? "Recording replacement cancellation was requested, but it may already have completed. Retrying this name is safe; Andoracle asks before any replacement."
      : "");
    setNameFocusRequest((request) => request + 1);
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      cancelActiveSubmission("Sequence dialog unmounted during submission.");
      busyRef.current = false;
      origin?.focus({ preventScroll: true });
    };
    // Each dialog instance owns one submission lifecycle. Refs provide the
    // latest active operation without restarting that lifecycle on rerenders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (stage === "review") {
        if (take.noteCount > 0) keepButtonRef.current?.focus();
        else discardButtonRef.current?.focus();
      }
      else if (!saveConflict) nameInputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [saveConflict, stage, take.noteCount]);

  useEffect(() => {
    if (!saveConflict) return;
    const timer = window.setTimeout(() => replaceCancelRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [saveConflict]);

  useEffect(() => {
    if (saveConflict || nameFocusRequest === 0) return;
    const timer = window.setTimeout(() => nameInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [nameFocusRequest, saveConflict]);

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busyRef.current || stage !== "name" || take.noteCount === 0) return;
    if (saveConflict) {
      const expected = snapshotSequence(saveConflict);
      const controller = new AbortController();
      const { active, race } = beginSubmission(controller);
      try {
        const result = await race(onReplace(expected, controller.signal));
        if (!releaseSubmission(active)) return;
        setBusy(false);
        if (result) {
          setSaveConflict(null);
          setError(result);
          setNameFocusRequest((request) => request + 1);
        }
      } catch {
        if (!releaseSubmission(active)) return;
        setBusy(false);
        setSaveConflict(null);
        setError("This recording could not be replaced. Try again.");
        setNameFocusRequest((request) => request + 1);
      }
      return;
    }

    const controller = new AbortController();
    const { active, race } = beginSubmission(controller);
    try {
      const result = await race(onSave(draftName, controller.signal));
      if (!releaseSubmission(active)) return;
      setBusy(false);
      if (result !== null && typeof result === "object") {
        setSaveConflict(snapshotSequence(result.existingSequence));
        return;
      }
      if (result) {
        setError(result);
        nameInputRef.current?.focus();
      }
    } catch {
      if (!releaseSubmission(active)) return;
      setBusy(false);
      setError("This sequence could not be saved. Try again.");
    }
  };

  const handleEscape = (event: KeyboardEvent<HTMLDialogElement>): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (saveConflict) {
      returnToNameForm();
    } else if (!busyRef.current && stage === "name") {
      setError("");
      setStage("review");
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="direct-entry sequence-commit-dialog"
      role={saveConflict ? "alertdialog" : undefined}
      aria-labelledby="sequence-commit-title"
      aria-describedby={saveConflict
        ? "sequence-replace-description sequence-library-error"
        : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (saveConflict) {
          returnToNameForm();
        } else if (!busyRef.current && stage === "name") {
          setError("");
          setStage("review");
        }
      }}
      onKeyDown={handleEscape}
    >
      <form noValidate aria-busy={busy} onSubmit={(event) => void save(event)}>
        <div className="modal-kicker">Note sequencer</div>
        <h2 id="sequence-commit-title">
          {stage === "review"
            ? "Keep this recording?"
            : saveConflict
              ? "Replace saved recording?"
              : "Name sequence"}
        </h2>

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
        ) : saveConflict ? (
          <>
            <p id="sequence-replace-description" className="modal-current delete-target-name">
              Replace “{saveConflict.name}” with this recording?
            </p>
            <p id="sequence-library-error" className="modal-error" role="alert">{error}</p>
            <div className="modal-actions">
              <button
                ref={replaceCancelRef}
                type="button"
                className="button button--quiet"
                onClick={() => returnToNameForm()}
              >
                Cancel
              </button>
              <button type="submit" className="button button--danger" disabled={busy}>
                Replace
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
              maxLength={USER_SEQUENCE_NAME_MAX_LENGTH}
              value={draftName}
              readOnly={busy}
              aria-invalid={Boolean(error)}
              aria-describedby="sequence-library-help sequence-library-error"
              onChange={(event) => {
                setDraftName(truncateUserLibraryName(event.target.value));
                setError("");
              }}
            />
            <p id="sequence-library-help" className="valid-range">
              Up to {USER_SEQUENCE_NAME_MAX_LENGTH} characters. Leading and trailing whitespace is removed. Matching names can be replaced after confirmation, regardless of capitalization.
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
