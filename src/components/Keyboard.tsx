import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { midiNoteName } from "../synth/params";

interface KeyboardProps {
  activeNotes: ReadonlySet<number>;
  allocatedLow: number | null;
  allocatedHigh: number | null;
  resetEpoch: number;
  onNoteOn: (source: string, note: number) => void;
  onNoteOff: (source: string) => void;
}

const START_NOTE = 36;
const END_NOTE = 72;
const BLACK_KEY_WIDTH = 0.625;
const WHITE_PITCHES = new Set([0, 2, 4, 5, 7, 9, 11]);
const KEYBOARD_ROW_RANGES = [
  [36, 47],
  [48, 59],
  [60, 72],
] as const;

type VisualActivation = " " | "Enter" | "assistive";

export const isVisualActivationKey = (key: string): key is Exclude<VisualActivation, "assistive"> => (
  key === " " || key === "Enter"
);

export const visualKeySource = (note: number, activation: VisualActivation): string => {
  const token = activation === " " ? "Space" : activation;
  return `visual-key:${note}:${token}`;
};

export const isSyntheticActivationClick = (detail: number): boolean => detail === 0;

export const shouldToggleAssistiveKey = (detail: number, keyboardClickSuppressed: boolean): boolean => (
  isSyntheticActivationClick(detail) && !keyboardClickSuppressed
);

export const focusKeyboardNote = (
  note: number,
  keyElements: ReadonlyMap<number, Pick<HTMLButtonElement, "focus">>,
): number => {
  const next = Math.max(START_NOTE, Math.min(END_NOTE, note));
  keyElements.get(next)?.focus({ preventScroll: true });
  return next;
};

export const clearKeyboardOwnership = (
  pointerNotes: Map<number, number>,
  visualKeySources: Map<string, number>,
  clickSuppressions: Set<string>,
  suppressionTimers: Map<string, number>,
  onNoteOff: (source: string) => void,
  clearTimer: (timer: number) => void,
): void => {
  for (const pointerId of pointerNotes.keys()) onNoteOff(`pointer:${pointerId}`);
  for (const source of visualKeySources.keys()) onNoteOff(source);
  for (const timer of suppressionTimers.values()) clearTimer(timer);
  pointerNotes.clear();
  visualKeySources.clear();
  clickSuppressions.clear();
  suppressionTimers.clear();
};

interface KeyGeometry {
  note: number;
  white: boolean;
  left: number;
}

interface KeyboardRowGeometry {
  startNote: number;
  endNote: number;
  whiteCount: number;
  keys: KeyGeometry[];
}

const isWhite = (note: number): boolean => WHITE_PITCHES.has(((note % 12) + 12) % 12);

export const createKeyboardRowGeometry = (startNote: number, endNote: number): KeyboardRowGeometry => {
  const keys: KeyGeometry[] = [];
  let whiteCount = 0;
  for (let note = startNote; note <= endNote; note += 1) {
    if (isWhite(note)) {
      keys.push({ note, white: true, left: whiteCount });
      whiteCount += 1;
    } else {
      keys.push({ note, white: false, left: whiteCount - BLACK_KEY_WIDTH / 2 });
    }
  }
  return { startNote, endNote, whiteCount, keys };
};

const KEYBOARD_ROWS = KEYBOARD_ROW_RANGES.map(([startNote, endNote]) => (
  createKeyboardRowGeometry(startNote, endNote)
));

export function Keyboard({
  activeNotes,
  allocatedLow,
  allocatedHigh,
  resetEpoch,
  onNoteOn,
  onNoteOff,
}: KeyboardProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const pointerNotes = useRef(new Map<number, number>());
  const visualKeySources = useRef(new Map<string, number>());
  const clickSuppressions = useRef(new Set<string>());
  const suppressionTimers = useRef(new Map<string, number>());
  const keyElements = useRef(new Map<number, HTMLButtonElement>());
  const [focusedNote, setFocusedNote] = useState(START_NOTE);

  const releaseAll = (): void => clearKeyboardOwnership(
    pointerNotes.current,
    visualKeySources.current,
    clickSuppressions.current,
    suppressionTimers.current,
    onNoteOff,
    (timer) => window.clearTimeout(timer),
  );

  useEffect(() => {
    const releaseWhenHidden = (): void => {
      if (document.hidden) releaseAll();
    };
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", releaseWhenHidden);
    return () => {
      window.removeEventListener("blur", releaseAll);
      document.removeEventListener("visibilitychange", releaseWhenHidden);
      releaseAll();
    };
  }, [onNoteOff]);

  useEffect(() => {
    releaseAll();
  }, [resetEpoch]);

  const noteAtPoint = (x: number, y: number): number | null => {
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-note]");
    if (!element || !surfaceRef.current?.contains(element)) return null;
    const note = Number(element.dataset.note);
    return Number.isFinite(note) ? note : null;
  };

  const moveKeyboardFocus = (note: number): void => {
    setFocusedNote(focusKeyboardNote(note, keyElements.current));
  };

  const begin = (event: PointerEvent<HTMLDivElement>): void => {
    const note = noteAtPoint(event.clientX, event.clientY);
    if (note === null) return;
    moveKeyboardFocus(note);
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerNotes.current.set(event.pointerId, note);
    onNoteOn(`pointer:${event.pointerId}`, note);
  };

  const move = (event: PointerEvent<HTMLDivElement>): void => {
    const previous = pointerNotes.current.get(event.pointerId);
    if (previous === undefined) return;
    const next = noteAtPoint(event.clientX, event.clientY);
    if (next === null || next === previous) return;
    const source = `pointer:${event.pointerId}`;
    onNoteOff(source);
    pointerNotes.current.set(event.pointerId, next);
    onNoteOn(source, next);
  };

  const end = (event: PointerEvent<HTMLDivElement>): void => {
    if (!pointerNotes.current.has(event.pointerId)) return;
    onNoteOff(`pointer:${event.pointerId}`);
    pointerNotes.current.delete(event.pointerId);
  };

  const activateVisualKey = (note: number, activation: VisualActivation): void => {
    const source = visualKeySource(note, activation);
    if (visualKeySources.current.has(source)) return;
    visualKeySources.current.set(source, note);
    onNoteOn(source, note);
  };

  const suppressKeyboardClick = (note: number, activation: Exclude<VisualActivation, "assistive">): void => {
    const source = visualKeySource(note, activation);
    const pendingTimer = suppressionTimers.current.get(source);
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    suppressionTimers.current.delete(source);
    clickSuppressions.current.add(source);
  };

  const deferKeyboardClickRelease = (note: number, activation: Exclude<VisualActivation, "assistive">): void => {
    const source = visualKeySource(note, activation);
    const pendingTimer = suppressionTimers.current.get(source);
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    const timer = window.setTimeout(() => {
      clickSuppressions.current.delete(source);
      suppressionTimers.current.delete(source);
    }, 0);
    suppressionTimers.current.set(source, timer);
  };

  const releaseVisualKey = (note: number, activation: VisualActivation): void => {
    const source = visualKeySource(note, activation);
    if (!visualKeySources.current.delete(source)) return;
    onNoteOff(source);
  };

  const releaseVisualNote = (note: number): void => {
    for (const [source, sourceNote] of visualKeySources.current) {
      if (sourceNote !== note) continue;
      visualKeySources.current.delete(source);
      onNoteOff(source);
    }
    for (const activation of [" ", "Enter"] as const) {
      const source = visualKeySource(note, activation);
      clickSuppressions.current.delete(source);
      const timer = suppressionTimers.current.get(source);
      if (timer !== undefined) window.clearTimeout(timer);
      suppressionTimers.current.delete(source);
    }
  };

  const syntheticClick = (note: number, event: MouseEvent<HTMLButtonElement>): void => {
    const keyboardClickSuppressed = ([" ", "Enter"] as const).some((activation) => (
      clickSuppressions.current.has(visualKeySource(note, activation))
    ));
    if (!shouldToggleAssistiveKey(event.detail, keyboardClickSuppressed)) return;
    const source = visualKeySource(note, "assistive");
    if (visualKeySources.current.delete(source)) onNoteOff(source);
    else activateVisualKey(note, "assistive");
  };

  const keyboardDown = (note: number, event: KeyboardEvent<HTMLButtonElement>): void => {
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        moveKeyboardFocus(note - 1);
        return;
      case "ArrowRight":
        event.preventDefault();
        moveKeyboardFocus(note + 1);
        return;
      case "ArrowDown":
        event.preventDefault();
        moveKeyboardFocus(note - 12);
        return;
      case "ArrowUp":
        event.preventDefault();
        moveKeyboardFocus(note + 12);
        return;
      case "Home":
        event.preventDefault();
        moveKeyboardFocus(START_NOTE);
        return;
      case "End":
        event.preventDefault();
        moveKeyboardFocus(END_NOTE);
        return;
      case " ":
      case "Enter":
        if (!event.repeat) {
          suppressKeyboardClick(note, event.key);
          activateVisualKey(note, event.key);
        }
        event.preventDefault();
        return;
    }
  };

  const keyboardUp = (note: number, event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!isVisualActivationKey(event.key)) return;
    event.preventDefault();
    releaseVisualKey(note, event.key);
    deferKeyboardClickRelease(note, event.key);
  };

  return (
    <section className="keyboard-module" aria-label="37-key keyboard">
      <div className="keyboard-header">
        <div>
          <span className="module-eyebrow">C2–C5 · low/high priority</span>
          <h2>37-key duophonic keyboard</h2>
        </div>
        <p><kbd>A S D F G H J K L ;</kbd> white · <kbd>W E T Y U O P</kbd> black. Click or tap a piano key, then Space or Enter plays it · drag for glissando.</p>
      </div>
      <div
        ref={surfaceRef}
        className="keyboard-banks"
        role="group"
        aria-label="On-screen keyboard"
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onContextMenu={(event) => event.preventDefault()}
      >
        {KEYBOARD_ROWS.map((row) => (
          <div
            key={row.startNote}
            className="keyboard-surface"
            role="group"
            aria-label={`${midiNoteName(row.startNote)} through ${midiNoteName(row.endNote)}`}
            data-keyboard-row
          >
            {[true, false].flatMap((white) => row.keys.filter((key) => key.white === white)).map((key) => {
              const active = activeNotes.has(key.note);
              const low = allocatedLow === key.note;
              const high = allocatedHigh === key.note;
              const width = key.white ? 1 : BLACK_KEY_WIDTH;
              return (
                <button
                  key={key.note}
                  type="button"
                  className={`piano-key piano-key--${key.white ? "white" : "black"}${active ? " is-active" : ""}${low ? " is-low" : ""}${high ? " is-high" : ""}`}
                  style={{
                    left: `${(key.left / row.whiteCount) * 100}%`,
                    width: `${(width / row.whiteCount) * 100}%`,
                  }}
                  data-note={key.note}
                  aria-label={midiNoteName(key.note)}
                  aria-pressed={active}
                  aria-keyshortcuts="Enter Space"
                  tabIndex={focusedNote === key.note ? 0 : -1}
                  ref={(element) => {
                    if (element) keyElements.current.set(key.note, element);
                    else keyElements.current.delete(key.note);
                  }}
                  onFocus={() => setFocusedNote(key.note)}
                  onKeyDown={(event) => keyboardDown(key.note, event)}
                  onKeyUp={(event) => keyboardUp(key.note, event)}
                  onClick={(event) => syntheticClick(key.note, event)}
                  onBlur={() => releaseVisualNote(key.note)}
                >
                  {key.white && key.note % 12 === 0 && <span>{midiNoteName(key.note)}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="allocation-legend" aria-hidden="true">
        <span><i className="dot dot--low" /> VCO 1 / lowest</span>
        <span><i className="dot dot--high" /> VCO 2 / highest</span>
      </div>
    </section>
  );
}
