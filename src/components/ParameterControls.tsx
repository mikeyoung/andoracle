import {
  useEffect,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  PARAM_SPECS,
  describeValidValues,
  formatParamValue,
  normalizeParamValue,
  normalizedToParam,
  paramToNormalized,
  type ParamKey,
  type SynthParams,
} from "../synth/params";
import {
  shouldRestoreDirectEntryOrigin,
  type DirectEntryInteractionModality,
} from "./direct-entry-focus";

interface SharedControlProps {
  param: ParamKey;
  value: number;
  accent: string;
  onChange: (key: ParamKey, value: number) => void;
  onDirectEdit: (key: ParamKey, origin: HTMLElement, restoreOriginFocus: boolean) => void;
  compact?: boolean;
  displayScale?: number;
}

type DirectHandlers = {
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  onKeyDownCapture: () => void;
  onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMoveCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUpCapture: () => void;
  onPointerCancelCapture: () => void;
  onLostPointerCaptureCapture: () => void;
};

interface InterruptionEventTarget {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
}

interface VisibilityInterruptionTarget extends InterruptionEventTarget {
  readonly hidden: boolean;
}

export class DirectEntryInterruptionRegistry {
  private readonly cancellers = new Set<() => void>();
  private listening = false;

  private readonly cancelAll = (): void => {
    for (const cancel of this.cancellers) cancel();
  };

  private readonly cancelWhenHidden = (): void => {
    if (this.documentTarget.hidden) this.cancelAll();
  };

  constructor(
    private readonly windowTarget: InterruptionEventTarget,
    private readonly documentTarget: VisibilityInterruptionTarget,
  ) {}

  subscribe(cancel: () => void): () => void {
    this.cancellers.add(cancel);
    if (!this.listening) {
      this.windowTarget.addEventListener("blur", this.cancelAll);
      this.documentTarget.addEventListener("visibilitychange", this.cancelWhenHidden);
      this.listening = true;
    }

    return () => {
      this.cancellers.delete(cancel);
      if (this.cancellers.size > 0 || !this.listening) return;
      this.windowTarget.removeEventListener("blur", this.cancelAll);
      this.documentTarget.removeEventListener("visibilitychange", this.cancelWhenHidden);
      this.listening = false;
    };
  }

  get subscriberCount(): number {
    return this.cancellers.size;
  }
}

export const shouldConsumeLongPressClick = (longPressConsumed: boolean, clickDetail: number): boolean => (
  longPressConsumed && clickDetail > 0
);

type SetSuppressionTimer = (callback: () => void, delayMs: number) => number;
type ClearSuppressionTimer = (timerId: number) => void;

/**
 * Owns the one-shot latch used to swallow the click synthesized by a touch
 * long press. Pointer cancellation is not guaranteed to produce that click,
 * so terminal pointer events also schedule a task-boundary expiry. This keeps
 * the current gesture protected without letting a stale latch survive into a
 * later activation.
 */
export class LongPressClickSuppression {
  private consumed = false;
  private expiryTimer: number | null = null;

  constructor(
    private readonly setTimer: SetSuppressionTimer = (callback, delayMs) => (
      window.setTimeout(callback, delayMs)
    ),
    private readonly clearTimer: ClearSuppressionTimer = (timerId) => window.clearTimeout(timerId),
  ) {}

  arm(): void {
    this.clearExpiryTimer();
    this.consumed = true;
  }

  reset(): void {
    this.clearExpiryTimer();
    this.consumed = false;
  }

  expireAfterGesture(): void {
    this.clearExpiryTimer();
    if (!this.consumed) return;
    this.expiryTimer = this.setTimer(() => {
      this.expiryTimer = null;
      this.consumed = false;
    }, 0);
  }

  consumeClick(clickDetail: number): boolean {
    if (!this.consumed) return false;
    const shouldConsume = shouldConsumeLongPressClick(true, clickDetail);
    this.reset();
    return shouldConsume;
  }

  consumeContextMenu(): boolean {
    if (!this.consumed) return false;
    this.reset();
    return true;
  }

  dispose(): void {
    this.reset();
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer === null) return;
    this.clearTimer(this.expiryTimer);
    this.expiryTimer = null;
  }
}

let directEntryInterruptionRegistry: DirectEntryInterruptionRegistry | null = null;

const getDirectEntryInterruptionRegistry = (): DirectEntryInterruptionRegistry => {
  directEntryInterruptionRegistry ??= new DirectEntryInterruptionRegistry(window, document);
  return directEntryInterruptionRegistry;
};

const useDirectEntry = (
  param: ParamKey,
  onDirectEdit: SharedControlProps["onDirectEdit"],
  restoreValue?: () => void,
): DirectHandlers => {
  const timer = useRef<number | null>(null);
  const startPoint = useRef({ x: 0, y: 0 });
  const origin = useRef<HTMLElement | null>(null);
  const initialControlValue = useRef<string | null>(null);
  const interactionModality = useRef<DirectEntryInteractionModality>("unknown");
  const clickSuppression = useRef<LongPressClickSuppression | null>(null);
  clickSuppression.current ??= new LongPressClickSuppression();

  const cancel = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const interrupt = (): void => {
    cancel();
    clickSuppression.current?.reset();
    interactionModality.current = "unknown";
  };

  const endPointerGesture = (): void => {
    cancel();
    clickSuppression.current?.expireAfterGesture();
  };

  useEffect(() => {
    const unsubscribe = getDirectEntryInterruptionRegistry().subscribe(interrupt);
    return () => {
      cancel();
      clickSuppression.current?.dispose();
      unsubscribe();
    };
  }, []);

  return {
    onContextMenu: (event) => {
      event.preventDefault();
      cancel();
      if (clickSuppression.current?.consumeContextMenu()) return;
      const target = event.target as HTMLElement;
      const editOrigin = target.closest<HTMLElement>("input, select, button") ?? event.currentTarget;
      onDirectEdit(
        param,
        editOrigin,
        shouldRestoreDirectEntryOrigin(editOrigin, interactionModality.current),
      );
    },
    onClickCapture: (event) => {
      if (!clickSuppression.current?.consumeClick(event.detail)) return;
      event.preventDefault();
      event.stopPropagation();
    },
    onKeyDownCapture: () => {
      interactionModality.current = "keyboard";
    },
    onPointerDownCapture: (event) => {
      cancel();
      clickSuppression.current?.reset();
      interactionModality.current = "pointer";
      if (event.pointerType === "mouse") {
        return;
      }
      startPoint.current = { x: event.clientX, y: event.clientY };
      const target = event.target as HTMLElement;
      origin.current = target.closest<HTMLElement>("input, select, button") ?? event.currentTarget;
      initialControlValue.current = origin.current instanceof HTMLInputElement
        ? origin.current.value
        : null;
      timer.current = window.setTimeout(() => {
        clickSuppression.current?.arm();
        if (
          restoreValue
          && origin.current instanceof HTMLInputElement
          && initialControlValue.current !== null
          && origin.current.value !== initialControlValue.current
        ) {
          restoreValue();
        }
        if (origin.current) {
          onDirectEdit(
            param,
            origin.current,
            shouldRestoreDirectEntryOrigin(origin.current, "pointer"),
          );
        }
        timer.current = null;
      }, 620);
    },
    onPointerMoveCapture: (event) => {
      const distance = Math.hypot(
        event.clientX - startPoint.current.x,
        event.clientY - startPoint.current.y,
      );
      if (distance > 10) cancel();
    },
    onPointerUpCapture: endPointerGesture,
    onPointerCancelCapture: endPointerGesture,
    onLostPointerCaptureCapture: endPointerGesture,
  };
};

export const shouldEmitRangeChange = (current: number, next: number): boolean => !Object.is(current, next);

/**
 * Pointer users expect the computer-note keys to become active again as soon
 * as a fader gesture ends. Keyboard users never enter this path, so a fader
 * reached with Tab keeps focus for Arrow, Home, End, and Page key adjustment.
 */
export class DeferredRangePointerFocusRelease {
  private timer: number | null = null;

  constructor(
    private readonly setTimer: SetSuppressionTimer = (callback, delayMs) => (
      window.setTimeout(callback, delayMs)
    ),
    private readonly clearTimer: ClearSuppressionTimer = (timerId) => window.clearTimeout(timerId),
  ) {}

  schedule(target: Pick<HTMLInputElement, "blur">): void {
    this.dispose();
    this.timer = this.setTimer(() => {
      this.timer = null;
      target.blur();
    }, 0);
  }

  dispose(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}

/**
 * Gives controlled normalized faders predictable keyboard semantics. Native
 * one-unit movement in the 0–1000 presentation range can round straight back
 * to the current synth value (notably for integer and coarse-step controls),
 * leaving an Arrow key unable to move the fader at all.
 */
export const keyboardAdjustedRangeValue = (
  param: ParamKey,
  value: number,
  key: string,
): number | undefined => {
  const spec = PARAM_SPECS[param];
  switch (key) {
    case "ArrowUp":
    case "ArrowRight":
      return normalizeParamValue(param, value + spec.step);
    case "ArrowDown":
    case "ArrowLeft":
      return normalizeParamValue(param, value - spec.step);
    case "Home":
      return spec.min;
    case "End":
      return spec.max;
    case "PageUp":
      return normalizedToParam(param, paramToNormalized(param, value) + 0.1);
    case "PageDown":
      return normalizedToParam(param, paramToNormalized(param, value) - 0.1);
    default:
      return undefined;
  }
};

export const nextChoiceValue = (param: ParamKey, value: number): number | undefined => {
  const options = PARAM_SPECS[param].options ?? [];
  if (options.length === 0) return undefined;
  const current = options.findIndex((option) => option.value === value);
  return options[(current + 1) % options.length]?.value;
};

const accentStyle = (accent: string): CSSProperties => ({ "--accent": accent } as CSSProperties);

export function RangeControl({
  param,
  value,
  accent,
  onChange,
  onDirectEdit,
  compact = false,
  displayScale = 1,
}: SharedControlProps) {
  const pointerFocusRelease = useRef<DeferredRangePointerFocusRelease | null>(null);
  pointerFocusRelease.current ??= new DeferredRangePointerFocusRelease();
  useEffect(() => () => pointerFocusRelease.current?.dispose(), []);
  const spec = PARAM_SPECS[param];
  const directHandlers = useDirectEntry(param, onDirectEdit, () => onChange(param, value));
  const position = Math.round(paramToNormalized(param, value) * 1000);
  const displayedValue = value * displayScale;
  const rangeDescription = displayScale === 1
    ? describeValidValues(param)
    : `${spec.min * displayScale} ${spec.unit ?? ""} to ${spec.max * displayScale} ${spec.unit ?? ""}; step ${spec.step * displayScale} ${spec.unit ?? ""}`;

  return (
    <div
      className={`parameter parameter--range${compact ? " parameter--compact" : ""}`}
      data-param={param}
      style={accentStyle(accent)}
      {...directHandlers}
    >
      <label htmlFor={`param-${param}`}>{spec.shortLabel ?? spec.label}</label>
      <div className="fader-shell">
        <span className="fader-scale" aria-hidden="true">
          <i /><i /><i /><i /><i /><i /><i /><i /><i />
        </span>
        <input
          id={`param-${param}`}
          type="range"
          min="0"
          max="1000"
          step="1"
          value={position}
          aria-label={spec.label}
          aria-orientation="vertical"
          aria-valuetext={formatParamValue(param, displayedValue)}
          aria-describedby={`param-${param}-range`}
          onKeyDown={(event) => {
            const next = keyboardAdjustedRangeValue(param, value, event.key);
            if (next === undefined) return;
            event.preventDefault();
            if (shouldEmitRangeChange(value, next)) onChange(param, next);
          }}
          onChange={(event) => {
            const next = normalizedToParam(param, Number(event.target.value) / 1000);
            if (shouldEmitRangeChange(value, next)) onChange(param, next);
          }}
          onPointerUp={(event) => pointerFocusRelease.current?.schedule(event.currentTarget)}
          onPointerCancel={(event) => pointerFocusRelease.current?.schedule(event.currentTarget)}
          onLostPointerCapture={(event) => pointerFocusRelease.current?.schedule(event.currentTarget)}
        />
      </div>
      <output htmlFor={`param-${param}`}>{formatParamValue(param, displayedValue)}</output>
      <span id={`param-${param}-range`} className="visually-hidden">
        Valid range: {rangeDescription}.
      </span>
    </div>
  );
}

export function ChoiceControl({
  param,
  value,
  accent,
  onChange,
  onDirectEdit,
  compact = false,
}: SharedControlProps) {
  const spec = PARAM_SPECS[param];
  const directHandlers = useDirectEntry(param, onDirectEdit);
  const selectedLabel = spec.options?.find((option) => option.value === value)?.label ?? String(value);
  return (
    <div
      className={`parameter parameter--choice${compact ? " parameter--compact" : ""}`}
      data-param={param}
      style={accentStyle(accent)}
      {...directHandlers}
    >
      <label htmlFor={`param-${param}`}>{compact ? "Source" : spec.shortLabel ?? spec.label}</label>
      <button
        type="button"
        className="choice-button"
        id={`param-${param}`}
        aria-label={`${spec.label}: ${selectedLabel}`}
        onClick={() => {
          const next = nextChoiceValue(param, value);
          if (next !== undefined) onChange(param, next);
        }}
      >
        <span>{selectedLabel}</span>
        <i aria-hidden="true" />
      </button>
      {!compact && <output htmlFor={`param-${param}`}>{formatParamValue(param, value)}</output>}
    </div>
  );
}

export function ToggleControl({
  param,
  value,
  accent,
  onChange,
  onDirectEdit,
}: SharedControlProps) {
  const spec = PARAM_SPECS[param];
  const directHandlers = useDirectEntry(param, onDirectEdit);
  const enabled = value > 0.5;
  return (
    <div
      className="parameter parameter--toggle"
      data-param={param}
      style={accentStyle(accent)}
      {...directHandlers}
    >
      <span className="toggle-label" id={`label-${param}`}>{spec.shortLabel ?? spec.label}</span>
      <button
        type="button"
        className="toggle-switch"
        role="switch"
        aria-checked={enabled}
        aria-labelledby={`label-${param}`}
        onClick={() => onChange(param, enabled ? 0 : 1)}
      >
        <span aria-hidden="true" />
        <b>{enabled ? "ON" : "OFF"}</b>
      </button>
    </div>
  );
}

interface RoutedFaderProps {
  source: ParamKey;
  amount: ParamKey;
  values: SynthParams;
  accent: string;
  onChange: SharedControlProps["onChange"];
  onDirectEdit: SharedControlProps["onDirectEdit"];
}

export function RoutedFader({ source, amount, values, accent, onChange, onDirectEdit }: RoutedFaderProps) {
  return (
    <div className="route-control" style={accentStyle(accent)}>
      <ChoiceControl
        param={source}
        value={values[source]}
        accent={accent}
        onChange={onChange}
        onDirectEdit={onDirectEdit}
        compact
      />
      <RangeControl
        param={amount}
        value={values[amount]}
        accent={accent}
        onChange={onChange}
        onDirectEdit={onDirectEdit}
        compact
      />
    </div>
  );
}
