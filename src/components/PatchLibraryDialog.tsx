import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";

export type PatchLibraryMode = "save" | "load";

interface PatchLibraryDialogProps {
  mode: PatchLibraryMode;
  patchNames: readonly string[];
  origin: HTMLElement | null;
  onSave: (name: string) => string | null | Promise<string | null>;
  onLoad: (name: string) => string | null | Promise<string | null>;
  onClose: () => void;
}

export function PatchLibraryDialog({
  mode,
  patchNames,
  origin,
  onSave,
  onLoad,
  onClose,
}: PatchLibraryDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const firstPatchRef = useRef<HTMLInputElement>(null);
  const [draftName, setDraftName] = useState("");
  const [selectedName, setSelectedName] = useState(patchNames[0] ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submissionRef = useRef(0);
  const isSave = mode === "save";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const focusTimer = window.setTimeout(() => {
      if (isSave) nameInputRef.current?.focus();
      else firstPatchRef.current?.focus();
    }, 0);
    return () => {
      submissionRef.current += 1;
      window.clearTimeout(focusTimer);
      origin?.focus({ preventScroll: true });
    };
  }, [isSave, origin]);

  useEffect(() => {
    if (!isSave && !patchNames.includes(selectedName)) {
      setSelectedName(patchNames[0] ?? "");
    }
  }, [isSave, patchNames, selectedName]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const submission = ++submissionRef.current;
    setBusy(true);
    setError("");
    try {
      const result = await (isSave ? onSave(draftName) : onLoad(selectedName));
      if (submission !== submissionRef.current) return;
      if (result) {
        setError(result);
        if (isSave) nameInputRef.current?.focus();
        else firstPatchRef.current?.focus();
        return;
      }
      onClose();
    } catch {
      if (submission !== submissionRef.current) return;
      setError(`This patch could not be ${isSave ? "saved" : "loaded"}. Try again.`);
    } finally {
      if (submission === submissionRef.current) setBusy(false);
    }
  };

  const backdropClose = (event: MouseEvent<HTMLDialogElement>): void => {
    if (!busy && event.target === dialogRef.current) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="direct-entry patch-library-dialog"
      aria-labelledby="patch-library-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onClose();
      }}
      onClick={backdropClose}
    >
      <form noValidate aria-busy={busy} onSubmit={(event) => void submit(event)}>
        <div className="modal-kicker">User patch library</div>
        <h2 id="patch-library-title">{isSave ? "Save patch" : "Load patch"}</h2>

        {isSave ? (
          <>
            <p className="modal-current">Store a snapshot of every current synth control on this device.</p>
            <label htmlFor="patch-library-name">Patch name</label>
            <input
              ref={nameInputRef}
              id="patch-library-name"
              className="patch-name-field"
              type="text"
              autoComplete="off"
              value={draftName}
              aria-invalid={Boolean(error)}
              aria-describedby="patch-library-help patch-library-error"
              onChange={(event) => {
                setDraftName(event.target.value);
                setError("");
              }}
            />
            <p id="patch-library-help" className="valid-range">
              Leading and trailing whitespace is removed. Names must be unique, regardless of capitalization.
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
          <button type="button" className="button button--quiet" disabled={busy} onClick={onClose}>Cancel</button>
          <button
            type="submit"
            className="button button--primary"
            disabled={busy || (!isSave && patchNames.length === 0)}
          >
            {busy ? (isSave ? "Saving…" : "Loading…") : isSave ? "Save patch" : "Load selected"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
