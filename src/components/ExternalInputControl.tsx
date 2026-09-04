interface ExternalInputControlProps {
  enabled: boolean;
  busy: boolean;
  disabled?: boolean;
  error: string | null;
  onToggle: () => void;
}

export function ExternalInputControl({ enabled, busy, disabled = false, error, onToggle }: ExternalInputControlProps) {
  return (
    <div className="external-input-control">
      <span className="external-input-title">External audio</span>
      <button
        type="button"
        className={`external-input-button${enabled ? " is-enabled" : ""}`}
        aria-pressed={enabled}
        disabled={disabled}
        onClick={onToggle}
      >
        <i aria-hidden="true" />
        <b>{busy ? "Cancel connection" : enabled ? "Live input on" : "Use live input"}</b>
      </button>
      <small className={error ? "control-error" : undefined} role={error ? "alert" : undefined}>
        {error ?? "Audio interface or microphone → mixer → delay → filters"}
      </small>
    </div>
  );
}
