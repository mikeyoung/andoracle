import { Fragment, memo, useEffect, useState } from "react";
import type { OdysseyMeter } from "../audio/dsp-core";
import type { OdysseyAudioEngine } from "../audio/engine";
import { formatParamValue } from "../synth/params";

interface OutputMeterProps {
  peak: number;
}

export const EMPTY_ODYSSEY_METER: OdysseyMeter = {
  sampleRate: 44100,
  gate: false,
  lowNote: 48,
  highNote: 48,
  vco1Frequency: 0,
  vco2Frequency: 0,
  ar: 0,
  adsr: 0,
  sampleHold: 0,
  peak: 0,
  rms: 0,
};

export const odysseyMetersMatch = (left: OdysseyMeter, right: OdysseyMeter): boolean => (
  left.sampleRate === right.sampleRate
  && left.gate === right.gate
  && left.lowNote === right.lowNote
  && left.highNote === right.highNote
  && left.vco1Frequency === right.vco1Frequency
  && left.vco2Frequency === right.vco2Frequency
  && left.ar === right.ar
  && left.adsr === right.adsr
  && left.sampleHold === right.sampleHold
  && left.peak === right.peak
  && left.rms === right.rms
);

export const outputPeakPercent = (peak: number): number => (
  Number.isFinite(peak) ? Math.round(Math.min(1, Math.max(0, peak)) * 100) : 0
);

export function OutputMeter({ peak }: OutputMeterProps) {
  const percent = outputPeakPercent(peak);
  return (
    <div
      className="output-meter"
      role="meter"
      aria-label="Output peak"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${percent} percent`}
    >
      <span>OUTPUT</span>
      <div><i style={{ transform: `scaleX(${percent / 100})` }} /></div>
    </div>
  );
}

interface EngineTelemetryProps {
  engine: OdysseyAudioEngine;
  running: boolean;
  allocatedLow: number | null;
  allocatedHigh: number | null;
}

interface TelemetryReadoutProps {
  meter: OdysseyMeter;
  allocatedLow: number | null;
  allocatedHigh: number | null;
}

function TelemetryReadout({ meter, allocatedLow, allocatedHigh }: TelemetryReadoutProps) {
  return (
    <Fragment>
      <div className="voice-readout">
        <span>VCO 1</span>
        <strong>{meter.vco1Frequency > 0
          ? formatParamValue("vco1Coarse", meter.vco1Frequency)
          : "—"}</strong>
      </div>
      <div className="voice-readout">
        <span>VCO 2</span>
        <strong>{meter.vco2Frequency > 0
          ? formatParamValue("vco2Coarse", meter.vco2Frequency)
          : "—"}</strong>
      </div>
      <div className="voice-readout">
        <span>ALLOCATION</span>
        <strong>{allocatedLow !== null && allocatedHigh !== null
          ? `${allocatedLow} · ${allocatedHigh}`
          : "gate closed"}</strong>
      </div>
      <OutputMeter peak={meter.peak} />
    </Fragment>
  );
}

type LiveEngineTelemetryProps = Omit<EngineTelemetryProps, "running">;

/** A fresh mount for each power-on prevents a previous session's meter flashing. */
function LiveEngineTelemetry({
  engine,
  allocatedLow,
  allocatedHigh,
}: LiveEngineTelemetryProps) {
  const [snapshot, setSnapshot] = useState<{
    readonly engine: OdysseyAudioEngine;
    readonly meter: OdysseyMeter;
  }>(() => ({ engine, meter: EMPTY_ODYSSEY_METER }));

  useEffect(() => engine.onMeter((nextMeter) => {
    setSnapshot((current) => (
      current.engine === engine && odysseyMetersMatch(current.meter, nextMeter)
        ? current
        : { engine, meter: nextMeter }
    ));
  }), [engine]);

  return (
    <TelemetryReadout
      meter={snapshot.engine === engine ? snapshot.meter : EMPTY_ODYSSEY_METER}
      allocatedLow={allocatedLow}
      allocatedHigh={allocatedHigh}
    />
  );
}

/**
 * Keeps the worklet's display-only update stream below the App boundary. Meter
 * frames must never make every synth control reconcile at audio-display rate.
 */
function EngineTelemetryComponent({
  engine,
  running,
  allocatedLow,
  allocatedHigh,
}: EngineTelemetryProps) {
  return running ? (
    <LiveEngineTelemetry
      engine={engine}
      allocatedLow={allocatedLow}
      allocatedHigh={allocatedHigh}
    />
  ) : (
    <TelemetryReadout
      meter={EMPTY_ODYSSEY_METER}
      allocatedLow={allocatedLow}
      allocatedHigh={allocatedHigh}
    />
  );
}

export const EngineTelemetry = memo(EngineTelemetryComponent);
