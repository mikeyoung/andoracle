interface OutputMeterProps {
  peak: number;
}

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
