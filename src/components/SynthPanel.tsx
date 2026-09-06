import { memo, type CSSProperties } from "react";
import type { PerformanceState } from "../audio/dsp-core";
import type { ParamKey, SynthParams } from "../synth/params";
import {
  PANEL_SECTIONS,
  type LayoutItem,
  type PanelSectionDefinition,
} from "../ui/layout";
import { ExternalInputControl } from "./ExternalInputControl";
import { PanelScrews } from "./PanelScrews";
import {
  ChoiceControl,
  RangeControl,
  RoutedFader,
  ToggleControl,
} from "./ParameterControls";
import { PpcPads } from "./PpcPads";

export interface SynthPanelProps {
  section: PanelSectionDefinition;
  params: SynthParams;
  externalInputEnabled: boolean;
  externalInputBusy: boolean;
  externalInputError: string | null;
  powerBusy: boolean;
  inputResetEpoch: number;
  onChange: (key: ParamKey, value: number) => void;
  onDirectEdit: (
    key: ParamKey,
    origin: HTMLElement,
    restoreOriginFocus: boolean,
  ) => void;
  onToggleExternalInput: () => void;
  onPerformance: (state: Partial<PerformanceState>) => void;
}

interface PanelRenderMetadata {
  readonly paramKeys: readonly ParamKey[];
  readonly hasExternalInput: boolean;
  readonly hasPpc: boolean;
  readonly hasRoutedFaders: boolean;
}

const createPanelRenderMetadata = (section: PanelSectionDefinition): PanelRenderMetadata => {
  const paramKeys = new Set<ParamKey>();
  let hasExternalInput = false;
  let hasPpc = false;
  let hasRoutedFaders = false;
  for (const item of section.items) {
    if (item.kind === "external") {
      hasExternalInput = true;
    } else if (item.kind === "ppc") {
      hasPpc = true;
      paramKeys.add("ppcBendRange");
      paramKeys.add("ppcVibratoRange");
    } else if (item.kind === "route") {
      hasRoutedFaders = true;
      paramKeys.add(item.source);
      paramKeys.add(item.amount);
    } else {
      paramKeys.add(item.param);
    }
  }
  return { paramKeys: [...paramKeys], hasExternalInput, hasPpc, hasRoutedFaders };
};

const PANEL_RENDER_METADATA = new Map(
  PANEL_SECTIONS.map((section) => [section, createPanelRenderMetadata(section)] as const),
);

const metadataFor = (section: PanelSectionDefinition): PanelRenderMetadata => (
  PANEL_RENDER_METADATA.get(section) ?? createPanelRenderMetadata(section)
);

/** Whether a parameter update can leave this complete panel render untouched. */
export const panelParamValuesMatch = (
  section: PanelSectionDefinition,
  previous: SynthParams,
  next: SynthParams,
): boolean => {
  if (previous === next) return true;
  for (const key of metadataFor(section).paramKeys) {
    if (!Object.is(previous[key], next[key])) return false;
  }
  return true;
};

export const synthPanelPropsMatch = (previous: SynthPanelProps, next: SynthPanelProps): boolean => {
  if (
    previous.section !== next.section
    || previous.onChange !== next.onChange
    || previous.onDirectEdit !== next.onDirectEdit
  ) return false;

  const metadata = metadataFor(next.section);
  if (!panelParamValuesMatch(next.section, previous.params, next.params)) return false;
  if (
    metadata.hasExternalInput
    && (
      previous.externalInputEnabled !== next.externalInputEnabled
      || previous.externalInputBusy !== next.externalInputBusy
      || previous.externalInputError !== next.externalInputError
      || previous.powerBusy !== next.powerBusy
      || previous.onToggleExternalInput !== next.onToggleExternalInput
    )
  ) return false;
  if (
    metadata.hasPpc
    && (
      previous.inputResetEpoch !== next.inputResetEpoch
      || previous.onPerformance !== next.onPerformance
    )
  ) return false;
  return true;
};

function SynthPanelComponent({
  section,
  params,
  externalInputEnabled,
  externalInputBusy,
  externalInputError,
  powerBusy,
  inputResetEpoch,
  onChange,
  onDirectEdit,
  onToggleExternalInput,
  onPerformance,
}: SynthPanelProps) {
  const renderItem = (item: LayoutItem, index: number) => {
    const shared = {
      accent: section.accent,
      onChange,
      onDirectEdit,
    };
    switch (item.kind) {
      case "range":
        return (
          <RangeControl
            key={`${item.param}-${index}`}
            param={item.param}
            value={params[item.param]}
            displayScale={item.param === "vco1Coarse" && params.vco1Mode < 0.5 ? 0.01 : 1}
            {...shared}
          />
        );
      case "choice":
        return <ChoiceControl key={`${item.param}-${index}`} param={item.param} value={params[item.param]} {...shared} />;
      case "toggle":
        return <ToggleControl key={`${item.param}-${index}`} param={item.param} value={params[item.param]} {...shared} />;
      case "route":
        return <RoutedFader key={`${item.source}-${index}`} source={item.source} amount={item.amount} values={params} {...shared} />;
      case "external":
        return (
          <ExternalInputControl
            key={`external-${index}`}
            enabled={externalInputEnabled}
            busy={externalInputBusy}
            disabled={powerBusy}
            error={externalInputError}
            onToggle={onToggleExternalInput}
          />
        );
      case "ppc":
        return (
          <PpcPads
            key={`ppc-${index}`}
            bendRange={params.ppcBendRange}
            vibratoRange={params.ppcVibratoRange}
            resetEpoch={inputResetEpoch}
            onPerformance={onPerformance}
          />
        );
    }
  };
  const { hasRoutedFaders } = metadataFor(section);

  return (
    <section
      className={`module module--${section.id}`}
      style={{ "--module-accent": section.accent } as CSSProperties}
    >
      <PanelScrews />
      <header className="module-header">
        <span className="module-eyebrow">{section.eyebrow}</span>
        <h2>{section.title}</h2>
      </header>
      <div className={`control-bank${hasRoutedFaders ? " control-bank--routed" : ""}`}>
        {section.items.map(renderItem)}
      </div>
    </section>
  );
}

/**
 * Keeps unrelated state (notes, notices, transport, and other module faders)
 * from rebuilding every control element in this section.
 */
export const SynthPanel = memo(SynthPanelComponent, synthPanelPropsMatch);
