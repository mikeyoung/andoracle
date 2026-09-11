/** Tracks how a native selector was opened so keyboard browsing keeps focus. */
export type SelectInteractionModality = "keyboard" | "pointer";

type SetFocusTimer = (callback: () => void, delayMs: number) => number;
type ClearFocusTimer = (timerId: number) => void;
type RequestFocusFrame = (callback: FrameRequestCallback) => number;
type CancelFocusFrame = (frameId: number) => void;
const SELECT_PICKER_POLL_MS = 100;

interface NativeSelectFocusTarget extends Pick<HTMLSelectElement, "blur" | "matches"> {}

const supportsNativeSelectOpenState = (): boolean => {
  try {
    return typeof CSS !== "undefined"
      && typeof CSS.supports === "function"
      && CSS.supports("selector(select:open)")
      && typeof window.requestAnimationFrame === "function";
  } catch {
    return false;
  }
};

/**
 * Pointer-picked options should return focus to the page for computer-note
 * input. Native selectors can restore their own focus after the change event,
 * so release it on the next task. Keyboard-picked options keep focus so the
 * user can continue browsing.
 */
export class DeferredSelectFocusRelease {
  private timer: number | null = null;
  private pickerPollTimer: number | null = null;
  private frame: number | null = null;

  constructor(
    private readonly setTimer: SetFocusTimer = (callback, delayMs) => (
      window.setTimeout(callback, delayMs)
    ),
    private readonly clearTimer: ClearFocusTimer = (timerId) => window.clearTimeout(timerId),
    private readonly requestFrame: RequestFocusFrame = (callback) => window.requestAnimationFrame(callback),
    private readonly cancelFrame: CancelFocusFrame = (frameId) => window.cancelAnimationFrame(frameId),
    private readonly supportsOpenState: () => boolean = supportsNativeSelectOpenState,
  ) {}

  get hasPointerFocusReleasePending(): boolean {
    // Include the post-close task as well as the open-state frame watch. A
    // musical key pressed in that one-task handoff must not cancel the blur
    // and strand focus on the select again.
    return this.frame !== null || this.pickerPollTimer !== null || this.timer !== null;
  }

  /**
   * A native picker does not emit `change` when the user picks the current
   * option or dismisses it. Modern engines expose that lifecycle through
   * `select:open`; wait until it really closes before releasing focus so the
   * first frame cannot collapse a picker that has just opened.
   */
  watchPointerPicker(select: NativeSelectFocusTarget): boolean {
    this.cancelPickerWatch();
    if (!this.supportsOpenState()) return false;

    const checkPicker = (): void => {
      this.frame = null;
      let open: boolean;
      try {
        open = select.matches(":open");
      } catch {
        return;
      }
      if (open) {
        // A native popup can remain open while the user auditions choices.
        // Ten inexpensive checks per second are responsive on close without
        // burning a render-frame callback for the entire picker lifetime.
        this.pickerPollTimer = this.setTimer(() => {
          this.pickerPollTimer = null;
          checkPicker();
        }, SELECT_PICKER_POLL_MS);
        return;
      }
      this.finish(select, "pointer");
    };
    // `click` runs before the select's default activation in engines that
    // open on click. Reading :open on the following frame observes the final
    // native state without racing that default action.
    this.frame = this.requestFrame(checkPicker);
    return true;
  }

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
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.cancelPickerWatch();
  }

  private cancelPickerWatch(): void {
    if (this.frame !== null) {
      this.cancelFrame(this.frame);
      this.frame = null;
    }
    if (this.pickerPollTimer !== null) {
      this.clearTimer(this.pickerPollTimer);
      this.pickerPollTimer = null;
    }
  }
}
