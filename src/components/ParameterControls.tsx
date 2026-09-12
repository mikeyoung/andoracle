import {
  memo,
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
import { RasterLabel } from "./RasterLabel";
import { PhotoSwitchHardware } from "./PhotoSwitchHardware";

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
  onPointerUpCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancelCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onLostPointerCaptureCapture: (event: ReactPointerEvent<HTMLElement>) => void;
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

export const DIRECT_ENTRY_LONG_PRESS_DELAY_MS = 620;

interface DirectEntryPointerSample {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly button: number;
  readonly isPrimary: boolean;
  readonly clientX: number;
  readonly clientY: number;
}

/**
 * A primary left-button hold is a long press regardless of whether it came
 * from touch, pen, or a mouse. This keeps the visible “long-press” affordance
 * truthful on desktop while leaving right click to the context-menu path.
 */
export const shouldStartDirectEntryLongPress = (
  pointer: Pick<DirectEntryPointerSample, "button" | "isPrimary">,
): boolean => pointer.isPrimary && pointer.button === 0;

const directEntryMovementTolerance = (pointerType: string): number => {
  if (pointerType === "mouse") return 8;
  if (pointerType === "pen") return 12;
  // A finger contact naturally wanders more than a mouse cursor. Eighteen CSS
  // pixels remains far below an intentional 56px dial drag while avoiding
  // false cancellation on high-density touchscreens.
  return 18;
};

/**
 * Tracks one primary pointer from press to release. Keeping this state in one
 * owner avoids unrelated multi-touch events cancelling the active dial hold,
 * and makes every timer cancellable during unmount or page interruption.
 */
export class DirectEntryLongPressTracker {
  private timer: number | null = null;
  private pointerId: number | null = null;
  private startX = 0;
  private startY = 0;
  private movementTolerance = 0;

  constructor(
    private readonly setTimer: SetSuppressionTimer = (callback, delayMs) => (
      window.setTimeout(callback, delayMs)
    ),
    private readonly clearTimer: ClearSuppressionTimer = (timerId) => window.clearTimeout(timerId),
  ) {}

  begin(pointer: DirectEntryPointerSample, activate: () => void): boolean {
    if (!shouldStartDirectEntryLongPress(pointer)) return false;
    this.cancel();
    this.pointerId = pointer.pointerId;
    this.startX = pointer.clientX;
    this.startY = pointer.clientY;
    this.movementTolerance = directEntryMovementTolerance(pointer.pointerType);
    this.timer = this.setTimer(() => {
      this.timer = null;
      // The pointer can only be cleared by a matching terminal event or an
      // explicit interruption, so a stale callback can never open the modal.
      if (this.pointerId === pointer.pointerId) activate();
    }, DIRECT_ENTRY_LONG_PRESS_DELAY_MS);
    return true;
  }

  move(pointerId: number, clientX: number, clientY: number): boolean {
    if (this.pointerId !== pointerId) return false;
    const distance = Math.hypot(clientX - this.startX, clientY - this.startY);
    if (distance <= this.movementTolerance) return true;
    this.cancel();
    return false;
  }

  end(pointerId: number): boolean {
    if (this.pointerId !== pointerId) return false;
    this.cancel();
    return true;
  }

  cancel(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.pointerId = null;
  }
}

/**
 * Owns the one-shot latch used to swallow the click synthesized by a pointer
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
  const interactionModality = useRef<DirectEntryInteractionModality>("unknown");
  const clickSuppression = useRef<LongPressClickSuppression | null>(null);
  clickSuppression.current ??= new LongPressClickSuppression();
  const longPress = useRef<DirectEntryLongPressTracker | null>(null);
  longPress.current ??= new DirectEntryLongPressTracker();

  const cancel = (): void => {
    longPress.current?.cancel();
  };

  const interrupt = (): void => {
    cancel();
    clickSuppression.current?.reset();
    interactionModality.current = "unknown";
  };

  const endPointerGesture = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!longPress.current?.end(event.pointerId)) return;
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
      if (!shouldStartDirectEntryLongPress(event)) return;
      clickSuppression.current?.reset();
      interactionModality.current = "pointer";
      const target = event.target as HTMLElement;
      const editOrigin = target.closest<HTMLElement>("input, select, button") ?? event.currentTarget;
      const initialValue = editOrigin instanceof HTMLInputElement ? editOrigin.value : null;
      longPress.current?.begin({
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        button: event.button,
        isPrimary: event.isPrimary,
        clientX: event.clientX,
        clientY: event.clientY,
      }, () => {
        clickSuppression.current?.arm();
        if (
          restoreValue
          && editOrigin instanceof HTMLInputElement
          && initialValue !== null
          && editOrigin.value !== initialValue
        ) {
          restoreValue();
        }
        onDirectEdit(
          param,
          editOrigin,
          shouldRestoreDirectEntryOrigin(editOrigin, "pointer"),
        );
      });
    },
    onPointerMoveCapture: (event) => {
      longPress.current?.move(event.pointerId, event.clientX, event.clientY);
    },
    onPointerUpCapture: endPointerGesture,
    onPointerCancelCapture: endPointerGesture,
    onLostPointerCaptureCapture: endPointerGesture,
  };
};

export const shouldEmitRangeChange = (current: number, next: number): boolean => !Object.is(current, next);

const renderedRangePosition = (param: ParamKey, value: number): number => (
  Math.round(paramToNormalized(param, value) * 1000)
);

/**
 * Finds the smallest value in the requested direction that produces actual
 * rotary feedback. Several authentic controls expose much finer synth steps
 * than the 0-1000 photographed dial or its compact value readout can show.
 * Advancing only one declared step can therefore make an Arrow key appear to
 * do nothing and can leave aria-valuetext unchanged. Direct entry retains the
 * full declared precision; Arrow keys advance to the next perceivable stop.
 */
const keyboardArrowRangeValue = (
  param: ParamKey,
  value: number,
  direction: -1 | 1,
  displayScale: number,
): number => {
  const spec = PARAM_SPECS[param];
  const immediate = normalizeParamValue(param, value + direction * spec.step);
  if (Object.is(immediate, value)) return value;

  const currentPosition = renderedRangePosition(param, value);
  const currentText = formatParamValue(param, value * displayScale);
  const givesCompleteFeedback = (candidate: number): boolean => (
    renderedRangePosition(param, candidate) !== currentPosition
    && formatParamValue(param, candidate * displayScale) !== currentText
  );
  if (givesCompleteFeedback(immediate)) return immediate;

  let firstVisibleCandidate: number | undefined;
  for (
    let position = currentPosition + direction;
    position >= 0 && position <= 1000;
    position += direction
  ) {
    const candidate = normalizedToParam(param, position / 1000);
    if (direction > 0 ? candidate <= value : candidate >= value) continue;
    if (renderedRangePosition(param, candidate) === currentPosition) continue;
    firstVisibleCandidate ??= candidate;
    if (formatParamValue(param, candidate * displayScale) !== currentText) return candidate;
  }

  // At a formatting plateau immediately beside an endpoint, the dial can
  // still provide visible positional feedback even when its short text cannot.
  return firstVisibleCandidate ?? immediate;
};

type RangeArrowDirection = -1 | 1;

const rangeArrowDirection = (key: string): RangeArrowDirection | undefined => {
  switch (key) {
    case "ArrowUp":
    case "ArrowRight":
      return 1;
    case "ArrowDown":
    case "ArrowLeft":
      return -1;
    default:
      return undefined;
  }
};

interface RangeKeyboardTransition {
  readonly from: number;
  readonly to: number;
  readonly direction: RangeArrowDirection;
}

/**
 * Remembers just the last perceptible Arrow-key transition for one dial. Fine
 * synth steps often share a display bucket, so independently calculating the
 * opposite jump can land at the other edge of that bucket (for example
 * 0% -> 5% -> 4%). Reversing the immediately preceding transition restores
 * its exact source value while retaining full precision everywhere else.
 */
export class ReversibleRangeKeyboardStepper {
  private transition: RangeKeyboardTransition | null = null;

  adjust(
    param: ParamKey,
    value: number,
    key: string,
    displayScale = 1,
  ): number | undefined {
    const direction = rangeArrowDirection(key);
    if (direction === undefined) {
      this.reset();
      return keyboardAdjustedRangeValue(param, value, key, displayScale);
    }

    if (
      this.transition
      && this.transition.direction === -direction
      && Object.is(this.transition.to, value)
    ) {
      const restored = this.transition.from;
      this.transition = null;
      return restored;
    }

    const next = keyboardAdjustedRangeValue(param, value, key, displayScale);
    this.transition = next !== undefined && !Object.is(next, value)
      ? { from: value, to: next, direction }
      : null;
    return next;
  }

  reset(): void {
    this.transition = null;
  }
}

/**
 * Browser-generated pointer clicks have a positive detail count. Keyboard and
 * assistive activations report zero, so they retain focus for repeated switch
 * operation while pointer users return immediately to the performance keys.
 */
export const shouldReleaseChoicePointerFocus = (clickDetail: number): boolean => clickDetail > 0;

export interface RangePointerWindowTarget {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean,
  ): void;
}

const NOOP_RANGE_POINTER_WINDOW: RangePointerWindowTarget = {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

/**
 * Pointer users expect the computer-note keys to become active again as soon
 * as a dial gesture ends. Keyboard users never enter this path, so a dial
 * reached with Tab keeps focus for Arrow, Home, End, and Page key adjustment.
 */
export class DeferredRangePointerFocusRelease {
  private timer: number | null = null;
  private pointerId: number | null = null;
  private pointerTarget: Pick<HTMLInputElement, "blur"> | null = null;
  private readonly windowTarget: RangePointerWindowTarget;

  private readonly finishFromWindow = (event: Event): void => {
    const eventPointerId = (event as Event & { pointerId?: unknown }).pointerId;
    if (typeof eventPointerId !== "number") return;
    this.finishPointerGesture(eventPointerId);
  };

  private readonly interruptFromWindow = (): void => {
    const target = this.pointerTarget;
    this.detachPointerGesture();
    this.clearBlurTimer();
    // Window blur/pagehide cannot race a native pointer default that restores
    // focus, so release synchronously before the document becomes inactive.
    target?.blur();
  };

  constructor(
    private readonly setTimer: SetSuppressionTimer = (callback, delayMs) => (
      window.setTimeout(callback, delayMs)
    ),
    private readonly clearTimer: ClearSuppressionTimer = (timerId) => window.clearTimeout(timerId),
    windowTarget?: RangePointerWindowTarget,
  ) {
    this.windowTarget = windowTarget
      ?? (typeof window === "undefined" ? NOOP_RANGE_POINTER_WINDOW : window);
  }

  beginPointerGesture(target: Pick<HTMLInputElement, "blur">, pointerId: number): void {
    this.clearBlurTimer();
    this.detachPointerGesture();
    this.pointerTarget = target;
    this.pointerId = pointerId;
    // Capture sees an outside release even when another control stops the
    // bubble phase. Listeners exist only for the active dial gesture.
    this.windowTarget.addEventListener("pointerup", this.finishFromWindow, true);
    this.windowTarget.addEventListener("pointercancel", this.finishFromWindow, true);
    this.windowTarget.addEventListener("blur", this.interruptFromWindow);
    this.windowTarget.addEventListener("pagehide", this.interruptFromWindow);
  }

  finishPointerGesture(pointerId: number): boolean {
    if (this.pointerId !== pointerId || !this.pointerTarget) return false;
    const target = this.pointerTarget;
    this.detachPointerGesture();
    this.schedule(target);
    return true;
  }

  schedule(target: Pick<HTMLInputElement, "blur">): void {
    this.clearBlurTimer();
    this.detachPointerGesture();
    this.timer = this.setTimer(() => {
      this.timer = null;
      target.blur();
    }, 0);
  }

  dispose(): void {
    this.clearBlurTimer();
    this.detachPointerGesture();
  }

  private clearBlurTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private detachPointerGesture(): void {
    if (this.pointerId === null) return;
    this.windowTarget.removeEventListener("pointerup", this.finishFromWindow, true);
    this.windowTarget.removeEventListener("pointercancel", this.finishFromWindow, true);
    this.windowTarget.removeEventListener("blur", this.interruptFromWindow);
    this.windowTarget.removeEventListener("pagehide", this.interruptFromWindow);
    this.pointerId = null;
    this.pointerTarget = null;
  }
}

/**
 * Gives controlled normalized dials predictable keyboard semantics. Native
 * one-unit movement in the 0–1000 presentation range can round straight back
 * to the current synth value (notably for integer and coarse-step controls),
 * leaving an Arrow key unable to move the dial at all.
 */
export const keyboardAdjustedRangeValue = (
  param: ParamKey,
  value: number,
  key: string,
  displayScale = 1,
): number | undefined => {
  const spec = PARAM_SPECS[param];
  switch (key) {
    case "ArrowUp":
    case "ArrowRight":
      return keyboardArrowRangeValue(param, value, 1, displayScale);
    case "ArrowDown":
    case "ArrowLeft":
      return keyboardArrowRangeValue(param, value, -1, displayScale);
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

const accentStyles = new Map<string, CSSProperties>();
const rangeDescriptions = new Map<ParamKey, string>();

const accentStyle = (accent: string): CSSProperties => {
  const cached = accentStyles.get(accent);
  if (cached) return cached;
  const style = { "--accent": accent } as CSSProperties;
  accentStyles.set(accent, style);
  return style;
};

const rangeDescription = (param: ParamKey): string => {
  const cached = rangeDescriptions.get(param);
  if (cached !== undefined) return cached;
  const description = describeValidValues(param);
  rangeDescriptions.set(param, description);
  return description;
};

const PHOTO_SWITCH_VARIANTS = ["tapes", "synth", "delay"] as const;

export const photoSwitchVariantForParam = (
  param: ParamKey,
): (typeof PHOTO_SWITCH_VARIANTS)[number] => {
  let hash = 0;
  for (const character of param) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return PHOTO_SWITCH_VARIANTS[hash % PHOTO_SWITCH_VARIANTS.length];
};

function RangeControlComponent({
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
  const keyboardStepper = useRef<ReversibleRangeKeyboardStepper | null>(null);
  keyboardStepper.current ??= new ReversibleRangeKeyboardStepper();
  useEffect(() => () => pointerFocusRelease.current?.dispose(), []);
  const spec = PARAM_SPECS[param];
  const directHandlers = useDirectEntry(param, onDirectEdit, () => onChange(param, value));
  const position = Math.round(paramToNormalized(param, value) * 1000);
  const dialStyle = {
    "--dial-angle": `${-135 + (position / 1000) * 270}deg`,
  } as CSSProperties;
  const displayedValue = value * displayScale;
  // Formatting is visible both beside the dial and to assistive technology.
  // Compute it once per value change rather than repeating the same numeric
  // formatting work during a rapid pointer drag.
  const formattedValue = formatParamValue(param, displayedValue);
  const validRangeDescription = displayScale === 1
    ? rangeDescription(param)
    : `${spec.min * displayScale} ${spec.unit ?? ""} to ${spec.max * displayScale} ${spec.unit ?? ""}; step ${spec.step * displayScale} ${spec.unit ?? ""}`;

  return (
    <div
      className={`parameter parameter--range${compact ? " parameter--compact" : ""}`}
      data-param={param}
      style={accentStyle(accent)}
      {...directHandlers}
    >
      <label htmlFor={`param-${param}`}>
        <RasterLabel text={spec.shortLabel ?? spec.label} variant="control" />
      </label>
      <div className="dial-shell" style={dialStyle}>
        <input
          id={`param-${param}`}
          type="range"
          min="0"
          max="1000"
          step="1"
          value={position}
          aria-label={spec.label}
          aria-orientation="vertical"
          aria-valuetext={formattedValue}
          aria-describedby={`param-${param}-range`}
          onBlur={() => keyboardStepper.current?.reset()}
          onKeyDown={(event) => {
            const next = keyboardStepper.current?.adjust(param, value, event.key, displayScale);
            if (next === undefined) return;
            event.preventDefault();
            if (shouldEmitRangeChange(value, next)) onChange(param, next);
          }}
          onChange={(event) => {
            keyboardStepper.current?.reset();
            const next = normalizedToParam(param, Number(event.target.value) / 1000);
            if (shouldEmitRangeChange(value, next)) onChange(param, next);
          }}
          onPointerDown={(event) => {
            keyboardStepper.current?.reset();
            pointerFocusRelease.current?.beginPointerGesture(event.currentTarget, event.pointerId);
          }}
          onPointerUp={(event) => pointerFocusRelease.current?.finishPointerGesture(event.pointerId)}
          onPointerCancel={(event) => pointerFocusRelease.current?.finishPointerGesture(event.pointerId)}
          onLostPointerCapture={(event) => pointerFocusRelease.current?.finishPointerGesture(event.pointerId)}
        />
        <span className="dial-scale" aria-hidden="true">
          <i /><i /><i /><i /><i /><i /><i /><i /><i />
        </span>
        <span className="dial-face" aria-hidden="true"><i /></span>
      </div>
      <output htmlFor={`param-${param}`}>{formattedValue}</output>
      <span id={`param-${param}-range`} className="visually-hidden">
        Valid range: {validRangeDescription}.
      </span>
    </div>
  );
}

export const RangeControl = memo(RangeControlComponent);

function ChoiceControlComponent({
  param,
  value,
  accent,
  onChange,
  onDirectEdit,
  compact = false,
}: SharedControlProps) {
  const pointerFocusRelease = useRef<DeferredRangePointerFocusRelease | null>(null);
  pointerFocusRelease.current ??= new DeferredRangePointerFocusRelease();
  useEffect(() => () => pointerFocusRelease.current?.dispose(), []);
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
      <label htmlFor={`param-${param}`}>
        <RasterLabel text={compact ? "Source" : spec.shortLabel ?? spec.label} variant="control" />
      </label>
      <button
        type="button"
        className="choice-button"
        id={`param-${param}`}
        aria-label={`${spec.label}: ${selectedLabel}`}
        onClick={(event) => {
          const next = nextChoiceValue(param, value);
          if (next !== undefined) onChange(param, next);
          if (shouldReleaseChoicePointerFocus(event.detail)) {
            pointerFocusRelease.current?.schedule(event.currentTarget);
          }
        }}
      >
        <span>{selectedLabel}</span>
        <i aria-hidden="true" />
      </button>
      {!compact && <output htmlFor={`param-${param}`}>{formatParamValue(param, value)}</output>}
    </div>
  );
}

export const ChoiceControl = memo(ChoiceControlComponent);

function ToggleControlComponent({
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
      <span className="toggle-label" id={`label-${param}`}>
        <RasterLabel text={spec.shortLabel ?? spec.label} variant="control" />
      </span>
      <button
        type="button"
        className="toggle-switch"
        data-switch-variant={photoSwitchVariantForParam(param)}
        role="switch"
        aria-checked={enabled}
        aria-labelledby={`label-${param}`}
        onClick={() => onChange(param, enabled ? 0 : 1)}
      >
        <span aria-hidden="true">
          <PhotoSwitchHardware variant={photoSwitchVariantForParam(param)} enabled={enabled} />
        </span>
        <b><RasterLabel text={enabled ? "On" : "Off"} variant="micro" /></b>
      </button>
    </div>
  );
}

export const ToggleControl = memo(ToggleControlComponent);

interface RoutedFaderProps {
  source: ParamKey;
  amount: ParamKey;
  values: SynthParams;
  accent: string;
  onChange: SharedControlProps["onChange"];
  onDirectEdit: SharedControlProps["onDirectEdit"];
}

function RoutedFaderComponent({ source, amount, values, accent, onChange, onDirectEdit }: RoutedFaderProps) {
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

export const RoutedFader = memo(
  RoutedFaderComponent,
  (previous, next) => previous.source === next.source
    && previous.amount === next.amount
    && previous.values[previous.source] === next.values[next.source]
    && previous.values[previous.amount] === next.values[next.amount]
    && previous.accent === next.accent
    && previous.onChange === next.onChange
    && previous.onDirectEdit === next.onDirectEdit,
);
