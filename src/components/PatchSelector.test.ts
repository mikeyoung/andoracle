import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PARAMS, type SynthParams } from "../synth/params";
import type { UserPatch } from "../synth/user-patches";
import {
  PatchSelector,
  resolvePatchSelection,
  userPatchOptionValue,
} from "./PatchSelector";

const patch = (name: string, cutoff: number): UserPatch => ({
  name,
  params: { ...DEFAULT_PARAMS, filterCutoff: cutoff } as SynthParams,
});

describe("persistent patch selector controls", () => {
  const userPatches = [patch("Wide Pad", 1_200), patch("Acid Lead", 4_800)];

  it("renders every user patch even while a factory patch is selected", () => {
    const markup = renderToStaticMarkup(createElement(PatchSelector, {
      userPatches,
      activeUserPatchName: null,
      selectedFactoryName: "Init Andoracle",
      onSelectUserPatch: vi.fn(),
      onSelectFactoryPatch: vi.fn(),
    }));

    expect(markup).toContain('<optgroup label="Custom Patches">');
    expect(markup).toContain(">Wide Pad</option>");
    expect(markup).toContain(">Acid Lead</option>");
    expect(markup).toContain('<option value="Init Andoracle" selected="">Init Andoracle</option>');
  });

  it("omits the custom-patch heading when there are no saved custom patches", () => {
    const markup = renderToStaticMarkup(createElement(PatchSelector, {
      userPatches: [],
      activeUserPatchName: null,
      selectedFactoryName: "Init Andoracle",
      onSelectUserPatch: vi.fn(),
      onSelectFactoryPatch: vi.fn(),
    }));

    expect(markup).not.toContain('<optgroup label="Custom Patches">');
    expect(markup).toContain('<optgroup label="Factory patches">');
  });

  it("keeps the active user patch selected without hiding its siblings", () => {
    const markup = renderToStaticMarkup(createElement(PatchSelector, {
      userPatches,
      activeUserPatchName: "acid lead",
      selectedFactoryName: "Custom patch",
      onSelectUserPatch: vi.fn(),
      onSelectFactoryPatch: vi.fn(),
    }));

    expect(markup).toContain(`value="${userPatchOptionValue("Acid Lead")}" selected=""`);
    expect(markup).toContain(">Wide Pad</option>");
  });

  it("resolves namespaced user values separately from factory values", () => {
    expect(resolvePatchSelection(userPatchOptionValue("wide pad"), userPatches)).toEqual({
      kind: "user",
      patch: userPatches[0],
    });
    expect(resolvePatchSelection("Rubber Bass", userPatches)).toEqual({
      kind: "factory",
      name: "Rubber Bass",
    });
    expect(resolvePatchSelection(userPatchOptionValue("Missing"), userPatches)).toBeNull();
  });

  it("renders a maximum-length user name in full", () => {
    const widestName = "W".repeat(33);
    const markup = renderToStaticMarkup(createElement(PatchSelector, {
      userPatches: [patch(widestName, 2_400)],
      activeUserPatchName: null,
      selectedFactoryName: "Custom patch",
      onSelectUserPatch: vi.fn(),
      onSelectFactoryPatch: vi.fn(),
    }));

    expect(markup).toContain(`>${widestName}</option>`);
    expect(markup).not.toContain("…");
  });
});
