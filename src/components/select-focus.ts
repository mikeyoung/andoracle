/** Tracks how a native selector was opened so keyboard browsing keeps focus. */
export type SelectInteractionModality = "keyboard" | "pointer";

type SetFocusTimer = (callback: () => void, delayMs: number) => number;
type ClearFocusTimer = (timerId: number) => void;

/**
 * Pointer-picked options should return focus to the page for computer-note
 * input. Native selectors can restore their own focus after the change event,
 * so release it on the next task. Keyboard-picked options keep focus so the
 * user can continue browsing.
 */
export class DeferredSelectFocusRelease {
  private timer: number | null = null;

  constructor(
    private readonly setTimer: SetFocusTimer = (callback, delayMs) => (
      window.setTimeout(callback, delayMs)
    ),
    private readonly clearTimer: ClearFocusTimer = (timerId) => window.clearTimeout(timerId),
  ) {}

  finish(
    select: Pick<HTMLSelectElement, "blur">,
    modality: SelectInteractionModality,
  ): boolean {
    this.dispose();
    if (modality !== "pointer") return false;
    this.timer = this.setTimer(() => {
      this.timer = null;
      select.blur();
    }, 0);
    return true;
  }

  dispose(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}
