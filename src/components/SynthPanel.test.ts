import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PARAMS, PARAM_KEYS, type ParamKey } from "../synth/params";
import { PANEL_SECTIONS, type PanelSectionDefinition } from "../ui/layout";
import {
  panelParamValuesMatch,
  synthPanelPropsMatch,
  type SynthPanelProps,
} from "./SynthPanel";

const sectionParamKeys = (section: PanelSectionDefinition): readonly ParamKey[] => (
  [...new Set(section.items.flatMap((item): ParamKey[] => {
    if (item.kind === "external") return [];
    if (item.kind === "ppc") return ["ppcBendRange", "ppcVibratoRange"];
    return item.kind === "route" ? [item.source, item.amount] : [item.param];
  }))]
);

describe("SynthPanel render isolation", () => {
  it("invalidates each panel for all parameter values that it renders", () => {
    for (const section of PANEL_SECTIONS) {
      for (const key of sectionParamKeys(section)) {
        const next = { ...DEFAULT_PARAMS, [key]: DEFAULT_PARAMS[key] + 0.123 };
        expect(
          panelParamValuesMatch(section, DEFAULT_PARAMS, next),
          `${section.id} must update when ${key} changes`,
        ).toBe(false);
      }
    }
  });

  it("leaves panels eligible for memoization when only unrelated parameters change", () => {
    for (const section of PANEL_SECTIONS) {
      const ownKeys = new Set(sectionParamKeys(section));
      const unrelatedKey = PARAM_KEYS.find((key) => !ownKeys.has(key));
      expect(unrelatedKey, `${section.id} should have an unrelated parameter`).toBeDefined();
      const key = unrelatedKey!;
      const next = { ...DEFAULT_PARAMS, [key]: DEFAULT_PARAMS[key] + 0.123 };
      expect(
        panelParamValuesMatch(section, DEFAULT_PARAMS, next),
        `${section.id} should ignore unrelated ${key}`,
      ).toBe(true);
    }
  });

  it("tracks the non-parameter state and callbacks consumed by special panel items", () => {
    const controllers = PANEL_SECTIONS.find((section) => section.id === "controllers")!;
    const mixer = PANEL_SECTIONS.find((section) => section.id === "mixer")!;
    const vco = PANEL_SECTIONS.find((section) => section.id === "vco1")!;
    const onChange = vi.fn();
    const onDirectEdit = vi.fn();
    const onToggleExternalInput = vi.fn();
    const onPerformance = vi.fn();
    const props = (section: PanelSectionDefinition): SynthPanelProps => ({
      section,
      params: DEFAULT_PARAMS,
      externalInputEnabled: false,
      externalInputBusy: false,
      externalInputError: null,
      powerBusy: false,
      inputResetEpoch: 0,
      onChange,
      onDirectEdit,
      onToggleExternalInput,
      onPerformance,
    });

    const controllersProps = props(controllers);
    expect(synthPanelPropsMatch(
      controllersProps,
      { ...controllersProps, inputResetEpoch: 1 },
    )).toBe(false);
    expect(synthPanelPropsMatch(
      controllersProps,
      { ...controllersProps, onPerformance: vi.fn() },
    )).toBe(false);

    const mixerProps = props(mixer);
    expect(synthPanelPropsMatch(
      mixerProps,
      { ...mixerProps, externalInputEnabled: true },
    )).toBe(false);
    expect(synthPanelPropsMatch(
      mixerProps,
      { ...mixerProps, onToggleExternalInput: vi.fn() },
    )).toBe(false);

    const vcoProps = props(vco);
    expect(synthPanelPropsMatch(
      vcoProps,
      { ...vcoProps, externalInputEnabled: true, inputResetEpoch: 1 },
    )).toBe(true);
    expect(synthPanelPropsMatch(
      vcoProps,
      { ...vcoProps, onChange: vi.fn() },
    )).toBe(false);
  });
});
