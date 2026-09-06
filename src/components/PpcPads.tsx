import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import type { PerformanceState } from "../audio/dsp-core";

interface PpcPadsProps {
  bendRange: number;
  vibratoRange: number;
  resetEpoch: number;
  onPerformance: (state: Partial<PerformanceState>) => void;
}

export type PadKind = "down" | "vibrato" | "up";
export type PadActivation = " " | "Enter" | "assistive";

const PPC_PAD_KINDS = ["down", "vibrato", "up"] as const;
const PPC_PAD_LABELS: Readonly<Record<PadKind, string>> = {
  down: "Bend down",
  vibrato: "Vibrato",
  up: "Bend up",
};

export interface PpcPointerState {
  readonly kind: PadKind;
  depth: number;
  /** Geometry captured when pointer capture begins; touch-action prevents gesture scrolling. */
  readonly top: number;
  readonly height: number;
}

export const isPadActivationKey = (key: string): key is Exclude<PadActivation, "assistive"> => (
  key === " " || key === "Enter"
);

export const shouldToggleAssistivePad = (detail: number, keyboardClickSuppressed: boolean): boolean => (
  detail === 0 && !keyboardClickSuppressed
);

export const ppcPointerDepth = (
  clientY: number,
  top: number,
  height: number,
  pressure: number,
  pointerType: string,
): number => {
  const positionDepth = 1 - (clientY - top) / Math.max(1, height);
  const rawDepth = pointerType === "pen" && pressure > 0 ? pressure : positionDepth;
  return Math.max(0, Math.min(1, rawDepth));
};

/** Updates one captured pointer without forcing another layout measurement. */
export const updatePpcPointerDepth = (
  pointer: PpcPointerState,
  clientY: number,
  pressure: number,
  pointerType: string,
): boolean => {
  const nextDepth = ppcPointerDepth(
    clientY,
    pointer.top,
    pointer.height,
    pressure,
    pointerType,
  );
  if (Object.is(pointer.depth, nextDepth)) return false;
  pointer.depth = nextDepth;
  return true;
};

export const clearPpcOwnership = <PointerValue extends { kind: PadKind; depth: number }>(
  pointerValues: Map<number, PointerValue>,
  keyboardActivations: Record<PadKind, Set<PadActivation>>,
  clickSuppressions: Record<PadKind, Set<Exclude<PadActivation, "assistive">>>,
  suppressionTimers: Map<string, number>,
  clearTimer: (timer: number) => void,
): boolean => {
  const wasActive = pointerValues.size > 0
    || PPC_PAD_KINDS.some((kind) => keyboardActivations[kind].size > 0);
  pointerValues.clear();
  for (const kind of PPC_PAD_KINDS) {
    keyboardActivations[kind].clear();
    clickSuppressions[kind].clear();
  }
  for (const timer of suppressionTimers.values()) clearTimer(timer);
  suppressionTimers.clear();
  return wasActive;
};

function PpcPadsComponent({ bendRange, vibratoRange, resetEpoch, onPerformance }: PpcPadsProps) {
  const [pressed, setPressed] = useState<Set<PadKind>>(new Set());
  const pointerValues = useRef(new Map<number, PpcPointerState>());
  const keyboardActivations = useRef<Record<PadKind, Set<PadActivation>>>({
    down: new Set(),
    vibrato: new Set(),
    up: new Set(),
  });
  const clickSuppressions = useRef<Record<PadKind, Set<Exclude<PadActivation, "assistive">>>>({
    down: new Set(),
    vibrato: new Set(),
    up: new Set(),
  });
  const suppressionTimers = useRef(new Map<string, number>());
  const onPerformanceRef = useRef(onPerformance);
  onPerformanceRef.current = onPerformance;

  const reset = (updatePressed: boolean): void => {
    const wasActive = clearPpcOwnership(
      pointerValues.current,
      keyboardActivations.current,
      clickSuppressions.current,
      suppressionTimers.current,
      (timer) => window.clearTimeout(timer),
    );
    if (updatePressed) {
      setPressed((current) => current.size === 0 ? current : new Set());
    }
    if (wasActive) onPerformanceRef.current({ bendSemitones: 0, vibratoSemitones: 0 });
  };

  const emitPerformance = useCallback((updatePressed = true): void => {
    let down = keyboardActivations.current.down.size > 0 ? -bendRange : 0;
    let vibrato = keyboardActivations.current.vibrato.size > 0 ? vibratoRange : 0;
    let up = keyboardActivations.current.up.size > 0 ? bendRange : 0;
    const activeKinds = updatePressed ? new Set<PadKind>() : null;
    if (activeKinds) {
      for (const kind of PPC_PAD_KINDS) {
        if (keyboardActivations.current[kind].size > 0) activeKinds.add(kind);
      }
    }
    for (const pointer of pointerValues.current.values()) {
      activeKinds?.add(pointer.kind);
      if (pointer.kind === "down") down = Math.min(down, -bendRange * pointer.depth);
      else if (pointer.kind === "up") up = Math.max(up, bendRange * pointer.depth);
      else vibrato = Math.max(vibrato, vibratoRange * pointer.depth);
    }
    if (activeKinds) {
      setPressed((current) => (
        current.size === activeKinds.size && PPC_PAD_KINDS.every(
          (kind) => current.has(kind) === activeKinds.has(kind),
        )
          ? current
          : activeKinds
      ));
    }
    onPerformanceRef.current({
      bendSemitones: down + up,
      vibratoSemitones: vibrato,
    });
  }, [bendRange, vibratoRange]);

  const activate = (kind: PadKind, event: PointerEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = event.currentTarget.getBoundingClientRect();
    pointerValues.current.set(event.pointerId, {
      kind,
      depth: ppcPointerDepth(event.clientY, bounds.top, bounds.height, event.pressure, event.pointerType),
      top: bounds.top,
      height: bounds.height,
    });
    emitPerformance();
  };

  const releasePointer = (pointerId: number): void => {
    if (pointerValues.current.delete(pointerId)) emitPerformance();
  };

  const releaseKeyboard = (kind: PadKind, activation: Exclude<PadActivation, "assistive">): void => {
    if (keyboardActivations.current[kind].delete(activation)) emitPerformance();
    const timerKey = `${kind}:${activation}`;
    const pendingTimer = suppressionTimers.current.get(timerKey);
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    const timer = window.setTimeout(() => {
      clickSuppressions.current[kind].delete(activation);
      suppressionTimers.current.delete(timerKey);
    }, 0);
    suppressionTimers.current.set(timerKey, timer);
  };

  const keyboardActivate = (kind: PadKind, event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.repeat || !isPadActivationKey(event.key)) return;
    event.preventDefault();
    const timerKey = `${kind}:${event.key}`;
    const pendingTimer = suppressionTimers.current.get(timerKey);
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    suppressionTimers.current.delete(timerKey);
    clickSuppressions.current[kind].add(event.key);
    if (!keyboardActivations.current[kind].has(event.key)) {
      keyboardActivations.current[kind].add(event.key);
      emitPerformance();
    }
  };

  const syntheticClick = (kind: PadKind, event: MouseEvent<HTMLButtonElement>): void => {
    if (!shouldToggleAssistivePad(event.detail, clickSuppressions.current[kind].size > 0)) return;
    const activations = keyboardActivations.current[kind];
    if (activations.has("assistive")) activations.delete("assistive");
    else activations.add("assistive");
    emitPerformance();
  };

  const releasePad = (kind: PadKind): void => {
    const hadActivation = keyboardActivations.current[kind].size > 0;
    keyboardActivations.current[kind].clear();
    clickSuppressions.current[kind].clear();
    for (const activation of [" ", "Enter"] as const) {
      const timerKey = `${kind}:${activation}`;
      const timer = suppressionTimers.current.get(timerKey);
      if (timer !== undefined) window.clearTimeout(timer);
      suppressionTimers.current.delete(timerKey);
    }
    if (hadActivation) emitPerformance();
  };

  useEffect(() => {
    if (
      pointerValues.current.size > 0
      || PPC_PAD_KINDS.some((kind) => keyboardActivations.current[kind].size > 0)
    ) {
      emitPerformance();
    }
  }, [emitPerformance]);

  useEffect(() => {
    const resetWhenHidden = (): void => {
      if (document.hidden) reset(true);
    };
    const resetOnBlur = (): void => reset(true);
    window.addEventListener("blur", resetOnBlur);
    document.addEventListener("visibilitychange", resetWhenHidden);
    return () => {
      window.removeEventListener("blur", resetOnBlur);
      document.removeEventListener("visibilitychange", resetWhenHidden);
      reset(false);
    };
  }, []);

  useEffect(() => {
    reset(true);
  }, [resetEpoch]);

  return (
    <div className="ppc" role="group" aria-label="Proportional pitch controls">
      <span className="ppc-title">PPC</span>
      {PPC_PAD_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          className={`ppc-pad ppc-pad--${kind}${pressed.has(kind) ? " is-pressed" : ""}`}
          aria-label={`${PPC_PAD_LABELS[kind]} pressure pad`}
          aria-pressed={pressed.has(kind)}
          aria-keyshortcuts="Enter Space"
          onPointerDown={(event) => activate(kind, event)}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const pointer = pointerValues.current.get(event.pointerId);
            if (!pointer || !updatePpcPointerDepth(
              pointer,
              event.clientY,
              event.pressure,
              event.pointerType,
            )) return;
            // Pointer membership cannot change during a captured move. Keep
            // depth audio-rate responsive without enqueueing React state work.
            emitPerformance(false);
          }}
          onPointerUp={(event) => releasePointer(event.pointerId)}
          onPointerCancel={(event) => releasePointer(event.pointerId)}
          onLostPointerCapture={(event) => releasePointer(event.pointerId)}
          onKeyDown={(event) => keyboardActivate(kind, event)}
          onKeyUp={(event) => {
            if (!isPadActivationKey(event.key)) return;
            event.preventDefault();
            releaseKeyboard(kind, event.key);
          }}
          onClick={(event) => syntheticClick(kind, event)}
          onBlur={() => releasePad(kind)}
        >
          <span>{kind === "down" ? "−" : kind === "up" ? "+" : "≈"}</span>
          <b>{PPC_PAD_LABELS[kind]}</b>
        </button>
      ))}
    </div>
  );
}

export const PpcPads = memo(PpcPadsComponent);
