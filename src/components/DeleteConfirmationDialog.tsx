import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";

export type DeleteTargetKind = "patch" | "recording";

export const DELETE_CONFIRMATION_TIMEOUT_MS = 10_000;

interface DeleteConfirmationDialogProps {
  kind: DeleteTargetKind;
  name: string;
  origin: HTMLElement | null;
  fallbackOrigin?: HTMLElement | null;
  onConfirm: (signal: AbortSignal) => string | null | Promise<string | null>;
  onClose: () => void;
}

interface ActiveDeleteSubmission {
  readonly id: number;
  readonly controller: AbortController;
  timeoutId: number | null;
}

const abortError = (signal: AbortSignal): Error => {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal.reason === "string" ? signal.reason : "Deletion was cancelled.",
  );
  error.name = "AbortError";
  return error;
};

/**
 * Releases the dialog continuation immediately when its authority is revoked,
 * even if a consumer accidentally returns a promise that ignores the signal.
 */
export const raceDeleteConfirmationWithAbort = <T,>(
  operation: T | PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> => new Promise<T>((resolve, reject) => {
  let settled = false;
  const cleanup = (): void => signal.removeEventListener("abort", handleAbort);
  const settle = (callback: () => void): void => {
    if (settled) return;
    settled = true;
    cleanup();
    callback();
  };
  const handleAbort = (): void => settle(() => reject(abortError(signal)));

  signal.addEventListener("abort", handleAbort, { once: true });
  // Always observe the operation, including when the signal was already
  // aborted, so a later rejection cannot become unhandled.
  Promise.resolve(operation).then(
    (value) => settle(() => resolve(value)),
    (error: unknown) => settle(() => reject(error)),
  );
  if (signal.aborted) handleAbort();
});

export const deleteConfirmationTimeoutMessage = (kind: DeleteTargetKind): string => (
  `Deleting this ${kind} took longer than 10 seconds and was cancelled. Check the library before retrying.`
);

/** Accessible, deliberately two-step confirmation for local-library deletion. */
export function DeleteConfirmationDialog({
  kind,
  name,
  origin,
  fallbackOrigin = null,
  onConfirm,
  onClose,
}: DeleteConfirmationDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const returnTargetRef = useRef({ origin, fallbackOrigin });
  returnTargetRef.current = { origin, fallbackOrigin };
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [cancelFocusRequest, setCancelFocusRequest] = useState(0);
  const submissionRef = useRef(0);
  const activeSubmissionRef = useRef<ActiveDeleteSubmission | null>(null);
  const closeRequestedRef = useRef(false);

  const abortActiveSubmission = (message: string): void => {
    const active = activeSubmissionRef.current;
    if (!active) return;
    activeSubmissionRef.current = null;
    submissionRef.current += 1;
    if (active.timeoutId !== null) {
      window.clearTimeout(active.timeoutId);
      active.timeoutId = null;
    }
    active.controller.abort(new DOMException(message, "AbortError"));
    busyRef.current = false;
  };

  const requestClose = (): void => {
    if (closeRequestedRef.current) return;
    closeRequestedRef.current = true;
    abortActiveSubmission("Delete confirmation closed during submission.");
    onClose();
  };

  useEffect(() => {
    closeRequestedRef.current = false;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const focusTimer = window.setTimeout(() => cancelButtonRef.current?.focus(), 0);
    return () => {
      closeRequestedRef.current = true;
      abortActiveSubmission("Delete confirmation unmounted during submission.");
      busyRef.current = false;
      window.clearTimeout(focusTimer);
      const { origin: returnOrigin, fallbackOrigin: returnFallback } = returnTargetRef.current;
      const returnTarget = returnOrigin?.isConnected && !returnOrigin.matches(":disabled")
        ? returnOrigin
        : returnFallback;
      returnTarget?.focus({ preventScroll: true });
    };
    // The dialog is mounted once for a captured deletion target. Refs retain
    // the latest focus targets without restarting its async lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (busy || cancelFocusRequest === 0) return;
    // Queue focus after React has committed the enabled buttons.
    const focusTimer = window.setTimeout(() => cancelButtonRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [busy, cancelFocusRequest]);

  const releaseSubmission = (active: ActiveDeleteSubmission): boolean => {
    if (activeSubmissionRef.current !== active || active.id !== submissionRef.current) return false;
    activeSubmissionRef.current = null;
    if (active.timeoutId !== null) {
      window.clearTimeout(active.timeoutId);
      active.timeoutId = null;
    }
    busyRef.current = false;
    return true;
  };

  const showSubmissionError = (active: ActiveDeleteSubmission, message: string): void => {
    if (!releaseSubmission(active)) return;
    setBusy(false);
    setError(message);
    setCancelFocusRequest((request) => request + 1);
  };

  const confirm = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busyRef.current || closeRequestedRef.current) return;
    busyRef.current = true;
    const active: ActiveDeleteSubmission = {
      id: ++submissionRef.current,
      controller: new AbortController(),
      timeoutId: null,
    };
    activeSubmissionRef.current = active;
    active.timeoutId = window.setTimeout(() => {
      if (activeSubmissionRef.current !== active) return;
      activeSubmissionRef.current = null;
      active.timeoutId = null;
      submissionRef.current += 1;
      active.controller.abort(new DOMException("Delete confirmation timed out.", "TimeoutError"));
      busyRef.current = false;
      setBusy(false);
      setError(deleteConfirmationTimeoutMessage(kind));
      setCancelFocusRequest((request) => request + 1);
    }, DELETE_CONFIRMATION_TIMEOUT_MS);
    setBusy(true);
    setError("");

    try {
      const result = await raceDeleteConfirmationWithAbort(
        onConfirm(active.controller.signal),
        active.controller.signal,
      );
      if (result) {
        showSubmissionError(active, result);
        return;
      }
      if (!releaseSubmission(active)) return;
      setBusy(false);
      requestClose();
    } catch {
      showSubmissionError(active, `This ${kind} could not be deleted. Try again.`);
    }
  };

  const closeFromBackdrop = (event: MouseEvent<HTMLDialogElement>): void => {
    if (event.target === dialogRef.current) requestClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="direct-entry delete-confirmation-dialog"
      role="alertdialog"
      aria-labelledby="delete-confirmation-title"
      aria-describedby="delete-confirmation-description delete-confirmation-error"
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      }}
      onClick={closeFromBackdrop}
    >
      <form noValidate aria-busy={busy} onSubmit={(event) => void confirm(event)}>
        <div className="modal-kicker">Local {kind} library</div>
        <h2 id="delete-confirmation-title">Delete {kind}?</h2>
        <p id="delete-confirmation-description" className="modal-current delete-target-name">
          Permanently delete “{name}” from this device? This cannot be undone.
        </p>
        <p id="delete-confirmation-error" className="modal-error" role="alert">{error}</p>
        <div className="modal-actions">
          <button
            ref={cancelButtonRef}
            type="button"
            className="button button--quiet"
            onClick={requestClose}
          >
            Cancel
          </button>
          <button type="submit" className="button button--danger" disabled={busy}>
            {busy ? "Deleting…" : `Delete ${kind}`}
          </button>
        </div>
      </form>
    </dialog>
  );
}
