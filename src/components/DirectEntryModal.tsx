import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import {
  PARAM_SPECS,
  describeValidValues,
  isValidParamValue,
  type ParamKey,
} from "../synth/params";

interface DirectEntryModalProps {
  param: ParamKey;
  value: number;
  displayScale?: number;
  origin: HTMLElement | null;
  fallbackOrigin?: HTMLElement | null;
  restoreOriginFocus?: boolean;
  onApply: (key: ParamKey, value: number) => void;
  onClose: () => void;
}

export function DirectEntryModal({
  param,
  value,
  displayScale = 1,
  origin,
  fallbackOrigin = null,
  restoreOriginFocus = true,
  onApply,
  onClose,
}: DirectEntryModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const spec = PARAM_SPECS[param];
  const displayMultiplier = (spec.display === "percent" ? 100 : 1) * displayScale;
  const displayedValue = Number((value * displayMultiplier).toFixed(6));
  const [draft, setDraft] = useState(String(displayedValue));
  const [error, setError] = useState("");
  const supportsNegative = spec.min < 0;
  const validValues = displayScale === 1
    ? describeValidValues(param)
    : `${Number((spec.min * displayMultiplier).toFixed(6))} ${spec.unit ?? ""} to ${Number((spec.max * displayMultiplier).toFixed(6))} ${spec.unit ?? ""}; step ${Number((spec.step * displayMultiplier).toFixed(6))} ${spec.unit ?? ""}`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const focusTimer = window.setTimeout(() => inputRef.current?.select(), 0);
    return () => {
      window.clearTimeout(focusTimer);
      const returnTarget = restoreOriginFocus && origin?.isConnected
        ? origin
        : fallbackOrigin?.isConnected
          ? fallbackOrigin
          : null;
      returnTarget?.focus({ preventScroll: true });
    };
  }, [fallbackOrigin, origin, restoreOriginFocus]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (draft.trim() === "") {
      setError("Enter a numeric value before applying this parameter.");
      inputRef.current?.focus();
      return;
    }
    const parsed = Number(draft) / displayMultiplier;
    if (!isValidParamValue(param, parsed)) {
      setError(`Enter a valid value: ${validValues}.`);
      inputRef.current?.focus();
      return;
    }
    onApply(param, parsed);
    onClose();
  };

  const backdropClose = (event: MouseEvent<HTMLDialogElement>): void => {
    if (event.target === dialogRef.current) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="direct-entry"
      aria-labelledby="direct-entry-title"
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
      <form noValidate onSubmit={submit}>
        <div className="modal-kicker">Direct parameter entry</div>
        <h2 id="direct-entry-title">{spec.label}</h2>
        <p className="modal-current">Current value: <strong>{displayedValue}</strong>{spec.unit ? ` ${spec.unit}` : ""}</p>
        <label htmlFor="direct-entry-value">Numeric value</label>
        <div className="number-field">
          <input
            ref={inputRef}
            id="direct-entry-value"
            type="number"
            required
            inputMode={spec.step < 1 ? "decimal" : "numeric"}
            min={spec.min * displayMultiplier}
            max={spec.max * displayMultiplier}
            step={spec.step * displayMultiplier}
            value={draft}
            aria-describedby="direct-entry-range direct-entry-error"
            onChange={(event) => {
              setDraft(event.target.value);
              setError("");
            }}
          />
          {supportsNegative && (
            <button
              type="button"
              className="number-sign"
              aria-label="Change value sign"
              onClick={() => {
                setDraft((current) => current.startsWith("-") ? current.slice(1) : `-${current || "0"}`);
                setError("");
                inputRef.current?.focus();
              }}
            >
              +/−
            </button>
          )}
          {spec.unit && <span>{spec.unit}</span>}
        </div>
        <p id="direct-entry-range" className="valid-range">Valid values: {validValues}</p>
        <p id="direct-entry-error" className="modal-error" role="alert">{error}</p>
        <div className="modal-actions">
          <button type="button" className="button button--quiet" onClick={onClose}>Cancel</button>
          <button type="submit" className="button button--primary">Apply value</button>
        </div>
      </form>
    </dialog>
  );
}
