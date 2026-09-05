import { describe, expect, it, vi } from "vitest";
import { finishSelectChange } from "./select-focus";

describe("native selector focus modality", () => {
  it("blurs after a pointer selection so computer-note input resumes", () => {
    const blur = vi.fn();

    expect(finishSelectChange({ blur }, "pointer")).toBe(true);
    expect(blur).toHaveBeenCalledTimes(1);
  });

  it("retains focus after a keyboard selection for continued option navigation", () => {
    const blur = vi.fn();

    expect(finishSelectChange({ blur }, "keyboard")).toBe(false);
    expect(blur).not.toHaveBeenCalled();
  });
});
