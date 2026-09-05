import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { createOperationCancellation } from "../cancellable-operation";
import { USER_PATCH_NAME_MAX_LENGTH, type UserPatch } from "../synth/user-patches";
import { truncateUserLibraryName } from "../user-library-name";

export type PatchLibraryMode = "save" | "load";

export interface PatchSaveConflict {
  readonly status: "duplicate";
  readonly existingPatch: UserPatch;
}

export type PatchSaveOutcome = string | null | PatchSaveConflict;

interface PatchLibraryDialogProps {
  mode: PatchLibraryMode;
  patchNames: readonly string[];
  origin: HTMLElement | null;
  onSave: (name: string) => PatchSaveOutcome | Promise<PatchSaveOutcome>;
  onReplace: (
    expected: UserPatch,
    signal: AbortSignal,
  ) => string | null | Promise<string | null>;
  onLoad: (name: string) => string | null | Promise<string | null>;
  onClose: () => void;
}

interface ActiveSubmission {
  readonly id: number;
  readonly cancelWait: () => void;
  readonly replacementController: AbortController | null;
}

const snapshotPatch = (patch: UserPatch): UserPatch => ({
  name: patch.name,
  params: { ...patch.params },
});

export function PatchLibraryDialog({
  mode,
  patchNames,
  origin,
  onSave,
  onReplace,
  onLoad,
  onClose,
}: PatchLibraryDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const firstPatchRef = useRef<HTMLInputElement>(null);
  const replaceCancelRef = useRef<HTMLButtonElement>(null);
  const [draftName, setDraftName] = useState("");
  const [selectedName, setSelectedName] = useState(patchNames[0] ?? "");
  const [saveConflict, setSaveConflict] = useState<UserPatch | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const submissionRef = useRef(0);
  const activeSubmissionRef = useRef<ActiveSubmission | null>(null);
  const [nameFocusRequest, setNameFocusRequest] = useState(0);
  const isSave = mode === "save";

  const cancelActiveSubmission = (message: string): void => {
    const active = activeSubmissionRef.current;
    if (!active) return;
    activeSubmissionRef.current = null;
    submissionRef.current += 1;
    active.replacementController?.abort(new DOMException(message, "AbortError"));
    active.cancelWait();
    busyRef.current = false;
  };

  const releaseSubmission = (active: ActiveSubmission): boolean => {
    if (activeSubmissionRef.current !== active || active.id !== submissionRef.current) return false;
    activeSubmissionRef.current = null;
    busyRef.current = false;
    return true;
  };

  const beginSubmission = (replacementController: AbortController | null): {
    readonly active: ActiveSubmission;
    readonly race: <T>(operation: T | PromiseLike<T>) => Promise<T>;
  } => {
    busyRef.current = true;
    const cancellation = createOperationCancellation("Patch dialog closed during submission.");
    const active: ActiveSubmission = {
      id: ++submissionRef.current,
      cancelWait: cancellation.cancel,
      replacementController,
    };
    activeSubmissionRef.current = active;
    setBusy(true);
    setError("");
    return { active, race: cancellation.race };
  };

  const returnToNameForm = (message = "Patch replacement cancelled."): void => {
    cancelActiveSubmission(message);
    busyRef.current = false;
    setBusy(false);
    setSaveConflict(null);
    setError("");
    setNameFocusRequest((request) => request + 1);
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const focusTimer = window.setTimeout(() => {
      if (isSave) nameInputRef.current?.focus();
      else firstPatchRef.current?.focus();
    }, 0);
    return () => {
      cancelActiveSubmission("Patch dialog unmounted during submission.");
      busyRef.current = false;
      window.clearTimeout(focusTimer);
      origin?.focus({ preventScroll: true });
    };
    // Each dialog instance owns one submission lifecycle. Refs provide the
    // latest active operation without restarting that lifecycle on rerenders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSave, origin]);

  useEffect(() => {
    if (!saveConflict) return;
    const focusTimer = window.setTimeout(() => replaceCancelRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [saveConflict]);

  useEffect(() => {
    if (saveConflict || nameFocusRequest === 0) return;
    const focusTimer = window.setTimeout(() => nameInputRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [nameFocusRequest, saveConflict]);

  useEffect(() => {
    if (!isSave && !patchNames.includes(selectedName)) {
      setSelectedName(patchNames[0] ?? "");
    }
  }, [isSave, patchNames, selectedName]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busyRef.current) return;
    if (saveConflict) {
      const expected = snapshotPatch(saveConflict);
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
          return;
        }
        onClose();
      } catch {
        if (!releaseSubmission(active)) return;
        setBusy(false);
        setSaveConflict(null);
        setError("This patch could not be replaced. Try again.");
        setNameFocusRequest((request) => request + 1);
      }
      return;
    }

    const { active, race } = beginSubmission(null);
    try {
      const result = await race(isSave ? onSave(draftName) : onLoad(selectedName));
      if (!releaseSubmission(active)) return;
      setBusy(false);
      if (result !== null && typeof result === "object") {
        setSaveConflict(snapshotPatch(result.existingPatch));
        return;
      }
      if (result) {
        setError(result);
        if (isSave) nameInputRef.current?.focus();
        else firstPatchRef.current?.focus();
        return;
      }
      onClose();
    } catch {
      if (!releaseSubmission(active)) return;
      setBusy(false);
      setError(`This patch could not be ${isSave ? "saved" : "loaded"}. Try again.`);
    }
  };

  const backdropClose = (event: MouseEvent<HTMLDialogElement>): void => {
    if (event.target !== dialogRef.current) return;
    if (saveConflict) {
      returnToNameForm();
      return;
    }
    if (!busyRef.current) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="direct-entry patch-library-dialog"
      role={saveConflict ? "alertdialog" : undefined}
      aria-labelledby="patch-library-title"
      aria-describedby={saveConflict
        ? "patch-replace-description patch-library-error"
        : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (saveConflict) returnToNameForm();
        else if (!busyRef.current) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (saveConflict) returnToNameForm();
        else if (!busyRef.current) onClose();
      }}
      onClick={backdropClose}
    >
      <form noValidate aria-busy={busy} onSubmit={(event) => void submit(event)}>
        <div className="modal-kicker">User patch library</div>
        <h2 id="patch-library-title">
          {saveConflict ? "Replace saved patch?" : isSave ? "Save patch" : "Load patch"}
        </h2>

        {saveConflict ? (
          <p id="patch-replace-description" className="modal-current delete-target-name">
            Replace “{saveConflict.name}” with the current synth settings?
          </p>
        ) : isSave ? (
          <>
            <p className="modal-current">Store a snapshot of every current synth control on this device.</p>
            <label htmlFor="patch-library-name">Patch name</label>
            <input
              ref={nameInputRef}
              id="patch-library-name"
              className="patch-name-field"
              type="text"
              autoComplete="off"
              maxLength={USER_PATCH_NAME_MAX_LENGTH}
              value={draftName}
              readOnly={busy}
              aria-invalid={Boolean(error)}
              aria-describedby="patch-library-help patch-library-error"
              onChange={(event) => {
                setDraftName(truncateUserLibraryName(event.target.value));
                setError("");
              }}
            />
            <p id="patch-library-help" className="valid-range">
              Up to {USER_PATCH_NAME_MAX_LENGTH} characters. Leading and trailing whitespace is removed. Matching names can be replaced after confirmation, regardless of capitalization.
            </p>
          </>
        ) : patchNames.length > 0 ? (
          <>
            <p className="modal-current">Choose a locally saved patch. Loading it leaves audio power and connected devices unchanged.</p>
            <fieldset className="patch-library-list" aria-describedby="patch-library-error">
              <legend>Saved patches</legend>
              {patchNames.map((name, index) => (
                <label key={name} className={selectedName === name ? "is-selected" : ""}>
                  <input
                    ref={index === 0 ? firstPatchRef : undefined}
                    type="radio"
                    name="saved-patch"
                    value={name}
                    checked={selectedName === name}
                    aria-invalid={Boolean(error)}
                    onChange={() => {
                      setSelectedName(name);
                      setError("");
                    }}
                  />
                  <span>{name}</span>
                </label>
              ))}
            </fieldset>
          </>
        ) : (
          <p className="patch-library-empty" role="status">No user patches have been saved on this device yet.</p>
        )}

        <p id="patch-library-error" className="modal-error" role="alert">{error}</p>
        <div className="modal-actions">
          {saveConflict ? (
            <>
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
            </>
          ) : (
            <>
              <button type="button" className="button button--quiet" disabled={busy} onClick={onClose}>Cancel</button>
              <button
                type="submit"
                className="button button--primary"
                disabled={busy || (!isSave && patchNames.length === 0)}
              >
                {busy ? (isSave ? "Saving…" : "Loading…") : isSave ? "Save patch" : "Load selected"}
              </button>
            </>
          )}
        </div>
      </form>
    </dialog>
  );
}
