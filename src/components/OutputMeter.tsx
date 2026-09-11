import { memo, useEffect, useRef, useState } from "react";
import vuMeterFaceOffUrl from "../assets/console/vu-meter-face-off.png";
import vuMeterFaceUrl from "../assets/console/vu-meter-face.png";
import type { OdysseyMeter } from "../audio/dsp-core";
import type { OdysseyAudioEngine } from "../audio/engine";
import { RasterLabel } from "./RasterLabel";

interface OutputMeterProps {
  leftRms: number;
  rightRms: number;
  running: boolean;
}

const OUTPUT_VU_METER_CHANNEL_COUNT = 2;
const OUTPUT_VU_METER_CANVAS_WIDTH = 698;
const OUTPUT_VU_METER_CANVAS_HEIGHT = 260;
const OUTPUT_VU_METER_CANVAS_SCALE = 4;
const OUTPUT_VU_METER_FLOOR_DB = -48 + 20 * Math.log10(1.2);
const OUTPUT_VU_METER_CEILING_DB = -26 + 20 * Math.log10(1.2);
const OUTPUT_VU_METER_NATURAL_FREQUENCY = 20;
const OUTPUT_VU_METER_DAMPING_RATIO = 0.8;
const OUTPUT_VU_METER_MAX_PHYSICS_STEP_SECONDS = 1 / 120;
const OUTPUT_VU_METER_MAX_FRAME_SECONDS = 1 / 20;
const OUTPUT_VU_METER_POSITION_EPSILON = 0.0005;
const OUTPUT_VU_METER_VELOCITY_EPSILON = 0.002;
const OUTPUT_VU_METER_MIN_ANGLE = -11 * Math.PI / 15;
const OUTPUT_VU_METER_MAX_ANGLE = -23 * Math.PI / 90;

interface OutputVuMeterGeometry {
  readonly pivotX: number;
  readonly pivotY: number;
  readonly shaftStartDistance: number;
  readonly needleLength: number;
  readonly hubMaskCenterX: number;
  readonly hubMaskCenterY: number;
  readonly hubMaskRadius: number;
}

const OUTPUT_VU_METER_GEOMETRY: readonly OutputVuMeterGeometry[] = Object.freeze([
  Object.freeze({
    pivotX: 41.75,
    pivotY: 51.75,
    shaftStartDistance: -7,
    needleLength: 35,
    hubMaskCenterX: 42.5,
    hubMaskCenterY: 58,
    hubMaskRadius: 10.5,
  }),
  Object.freeze({
    pivotX: 131.75,
    pivotY: 51.75,
    shaftStartDistance: -7,
    needleLength: 35,
    hubMaskCenterX: 130.75,
    hubMaskCenterY: 58,
    hubMaskRadius: 10.5,
  }),
]);

const NOOP = (): void => undefined;

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
  leftRms: 0,
  rightRms: 0,
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
  && left.leftRms === right.leftRms
  && left.rightRms === right.rightRms
);

/** Chaotic Sound Effects' RMS-to-moving-coil calibration, clamped for hostile values. */
export const outputVuMeterDrive = (rms: number): number => {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  const decibels = 20 * Math.log10(rms);
  return Math.min(
    1,
    Math.max(
      0,
      (decibels - OUTPUT_VU_METER_FLOOR_DB)
        / (OUTPUT_VU_METER_CEILING_DB - OUTPUT_VU_METER_FLOOR_DB),
    ),
  );
};

/** Integrates the exact damped-spring needle model used by Chaotic Sound Effects. */
export function integrateOutputVuMeterPhysics(
  positions: Float64Array,
  velocities: Float64Array,
  drives: Float64Array,
  elapsedSeconds: number,
): void {
  let remaining = Math.min(
    OUTPUT_VU_METER_MAX_FRAME_SECONDS,
    Math.max(0, Number(elapsedSeconds) || 0),
  );
  const naturalFrequency = OUTPUT_VU_METER_NATURAL_FREQUENCY;
  const springStrength = naturalFrequency * naturalFrequency;
  const damping = 2 * OUTPUT_VU_METER_DAMPING_RATIO * naturalFrequency;

  while (remaining > 0) {
    const step = Math.min(OUTPUT_VU_METER_MAX_PHYSICS_STEP_SECONDS, remaining);
    for (let channelIndex = 0; channelIndex < OUTPUT_VU_METER_CHANNEL_COUNT; channelIndex += 1) {
      let position = positions[channelIndex];
      let velocity = velocities[channelIndex];
      const acceleration = springStrength * (drives[channelIndex] - position) - damping * velocity;
      velocity += acceleration * step;
      position += velocity * step;

      if (position <= 0) {
        position = 0;
        if (velocity < 0) velocity = 0;
      } else if (position >= 1) {
        position = 1;
        if (velocity > 0) velocity = 0;
      }
      positions[channelIndex] = position;
      velocities[channelIndex] = velocity;
    }
    remaining -= step;
  }
}

export const outputVuMeterMotionIsSettled = (
  positions: Float64Array,
  velocities: Float64Array,
  drives: Float64Array,
): boolean => {
  for (let channelIndex = 0; channelIndex < OUTPUT_VU_METER_CHANNEL_COUNT; channelIndex += 1) {
    if (
      Math.abs(drives[channelIndex] - positions[channelIndex]) > OUTPUT_VU_METER_POSITION_EPSILON
      || Math.abs(velocities[channelIndex]) > OUTPUT_VU_METER_VELOCITY_EPSILON
    ) return false;
  }
  return true;
};

function drawOutputVuMeterNeedle(
  drawingContext: CanvasRenderingContext2D,
  positions: Float64Array,
  channelIndex: number,
): void {
  const geometry = OUTPUT_VU_METER_GEOMETRY[channelIndex];
  if (!geometry) return;

  const position = Math.min(1, Math.max(0, positions[channelIndex]));
  const angle = OUTPUT_VU_METER_MIN_ANGLE
    + position * (OUTPUT_VU_METER_MAX_ANGLE - OUTPUT_VU_METER_MIN_ANGLE);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const tipX = geometry.pivotX + cosine * geometry.needleLength;
  const tipY = geometry.pivotY + sine * geometry.needleLength;
  const redStartDistance = geometry.needleLength * 0.77;

  drawingContext.save();
  drawingContext.lineCap = "round";
  drawingContext.lineJoin = "round";
  drawingContext.shadowColor = "rgba(0, 0, 0, 0.65)";
  drawingContext.shadowBlur = 0.7;
  drawingContext.shadowOffsetX = 0.35;
  drawingContext.shadowOffsetY = 0.45;
  drawingContext.strokeStyle = "#27231d";
  drawingContext.lineWidth = 0.9;
  drawingContext.beginPath();
  drawingContext.moveTo(
    geometry.pivotX + cosine * geometry.shaftStartDistance,
    geometry.pivotY + sine * geometry.shaftStartDistance,
  );
  drawingContext.lineTo(tipX, tipY);
  drawingContext.stroke();

  drawingContext.shadowColor = "transparent";
  drawingContext.strokeStyle = "#8c3027";
  drawingContext.lineWidth = 0.78;
  drawingContext.beginPath();
  drawingContext.moveTo(
    geometry.pivotX + cosine * redStartDistance,
    geometry.pivotY + sine * redStartDistance,
  );
  drawingContext.lineTo(tipX, tipY);
  drawingContext.stroke();
  drawingContext.restore();
}

function maskOutputVuMeterHub(
  drawingContext: CanvasRenderingContext2D,
  channelIndex: number,
): void {
  const geometry = OUTPUT_VU_METER_GEOMETRY[channelIndex];
  if (!geometry) return;
  drawingContext.save();
  drawingContext.globalCompositeOperation = "destination-out";
  drawingContext.beginPath();
  drawingContext.arc(
    geometry.hubMaskCenterX,
    geometry.hubMaskCenterY,
    geometry.hubMaskRadius,
    0,
    Math.PI * 2,
  );
  drawingContext.fill();
  drawingContext.restore();
}

function drawOutputVuMeters(
  drawingContext: CanvasRenderingContext2D,
  positions: Float64Array,
): void {
  drawingContext.setTransform(
    OUTPUT_VU_METER_CANVAS_SCALE,
    0,
    0,
    OUTPUT_VU_METER_CANVAS_SCALE,
    0,
    0,
  );
  drawingContext.clearRect(
    0,
    0,
    OUTPUT_VU_METER_CANVAS_WIDTH / OUTPUT_VU_METER_CANVAS_SCALE,
    OUTPUT_VU_METER_CANVAS_HEIGHT / OUTPUT_VU_METER_CANVAS_SCALE,
  );
  for (let channelIndex = 0; channelIndex < OUTPUT_VU_METER_CHANNEL_COUNT; channelIndex += 1) {
    drawOutputVuMeterNeedle(drawingContext, positions, channelIndex);
  }
  for (let channelIndex = 0; channelIndex < OUTPUT_VU_METER_CHANNEL_COUNT; channelIndex += 1) {
    maskOutputVuMeterHub(drawingContext, channelIndex);
  }
}

export function OutputMeter({ leftRms, rightRms, running }: OutputMeterProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drivesRef = useRef<Float64Array | null>(null);
  const positionsRef = useRef<Float64Array | null>(null);
  const velocitiesRef = useRef<Float64Array | null>(null);
  const frameRef = useRef<number | null>(null);
  const previousTimestampRef = useRef(0);
  const startAnimationRef = useRef<() => void>(NOOP);

  const drives = drivesRef.current ?? (drivesRef.current = new Float64Array(OUTPUT_VU_METER_CHANNEL_COUNT));
  const positions = positionsRef.current
    ?? (positionsRef.current = new Float64Array(OUTPUT_VU_METER_CHANNEL_COUNT));
  const velocities = velocitiesRef.current
    ?? (velocitiesRef.current = new Float64Array(OUTPUT_VU_METER_CHANNEL_COUNT));
  const leftDrive = running ? outputVuMeterDrive(leftRms) : 0;
  const rightDrive = running ? outputVuMeterDrive(rightRms) : 0;
  const leftPercent = Math.round(leftDrive * 100);
  const rightPercent = Math.round(rightDrive * 100);

  useEffect(() => {
    const canvas = canvasRef.current;
    const drawingContext = canvas?.getContext("2d", { alpha: true });
    if (!drawingContext) return undefined;
    let active = true;

    const updateOutputVuMeters = (timestamp: number): void => {
      frameRef.current = null;
      if (!active || document.visibilityState !== "visible") {
        previousTimestampRef.current = 0;
        return;
      }

      const elapsedSeconds = previousTimestampRef.current > 0
        ? (timestamp - previousTimestampRef.current) / 1000
        : 1 / 60;
      previousTimestampRef.current = timestamp;
      integrateOutputVuMeterPhysics(positions, velocities, drives, elapsedSeconds);
      drawOutputVuMeters(drawingContext, positions);

      if (!outputVuMeterMotionIsSettled(positions, velocities, drives)) {
        frameRef.current = window.requestAnimationFrame(updateOutputVuMeters);
      } else {
        if (drives[0] === 0 && drives[1] === 0) {
          positions.fill(0);
          velocities.fill(0);
          drawOutputVuMeters(drawingContext, positions);
        }
        previousTimestampRef.current = 0;
      }
    };

    const startOutputVuMeterAnimation = (): void => {
      if (!active || frameRef.current !== null || document.visibilityState !== "visible") return;
      previousTimestampRef.current = 0;
      frameRef.current = window.requestAnimationFrame(updateOutputVuMeters);
    };
    startAnimationRef.current = startOutputVuMeterAnimation;

    const visibilityChanged = (): void => {
      if (document.visibilityState !== "visible") {
        if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
        previousTimestampRef.current = 0;
        return;
      }
      if (!outputVuMeterMotionIsSettled(positions, velocities, drives)) {
        startOutputVuMeterAnimation();
      }
    };

    drawOutputVuMeters(drawingContext, positions);
    document.addEventListener("visibilitychange", visibilityChanged);
    if (!outputVuMeterMotionIsSettled(positions, velocities, drives)) {
      startOutputVuMeterAnimation();
    }

    return () => {
      active = false;
      document.removeEventListener("visibilitychange", visibilityChanged);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      previousTimestampRef.current = 0;
      startAnimationRef.current = NOOP;
    };
  }, [drives, positions, velocities]);

  useEffect(() => {
    drives[0] = leftDrive;
    drives[1] = rightDrive;
    if (!outputVuMeterMotionIsSettled(positions, velocities, drives)) {
      startAnimationRef.current();
    }
  }, [drives, leftDrive, positions, rightDrive, velocities]);

  return (
    <div
      className={`output-meter${running ? " is-powered" : ""}`}
      role="group"
      aria-label="Stereo output level"
    >
      <span><RasterLabel text="Output" variant="micro" tone="muted" /></span>
      <div className="output-vu-meter" aria-hidden="true">
        <img
          className="output-vu-meter__face output-vu-meter__face--off"
          src={vuMeterFaceOffUrl}
          width={OUTPUT_VU_METER_CANVAS_WIDTH}
          height={OUTPUT_VU_METER_CANVAS_HEIGHT}
          alt=""
          draggable={false}
        />
        <img
          className="output-vu-meter__face output-vu-meter__face--on"
          src={vuMeterFaceUrl}
          width={OUTPUT_VU_METER_CANVAS_WIDTH}
          height={OUTPUT_VU_METER_CANVAS_HEIGHT}
          alt=""
          draggable={false}
        />
        <canvas
          ref={canvasRef}
          className="output-vu-meter__needles"
          width={OUTPUT_VU_METER_CANVAS_WIDTH}
          height={OUTPUT_VU_METER_CANVAS_HEIGHT}
        />
      </div>
      <div
        className="visually-hidden"
        role="meter"
        aria-label="Left output level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={leftPercent}
        aria-valuetext={`${leftPercent} percent`}
      />
      <div
        className="visually-hidden"
        role="meter"
        aria-label="Right output level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={rightPercent}
        aria-valuetext={`${rightPercent} percent`}
      />
    </div>
  );
}

interface LiveOutputMeterProps {
  engine: OdysseyAudioEngine;
  running: boolean;
}

/**
 * Keeps one physical meter mounted while power changes, so its needles can
 * return naturally to their stops. The running flag in each snapshot also
 * prevents a stale frame from a previous power session flashing on restart.
 */
function LiveOutputMeterComponent({
  engine,
  running,
}: LiveOutputMeterProps) {
  const [snapshot, setSnapshot] = useState<{
    readonly engine: OdysseyAudioEngine;
    readonly running: boolean;
    readonly meter: OdysseyMeter;
  }>(() => ({ engine, running: false, meter: EMPTY_ODYSSEY_METER }));

  useEffect(() => {
    let active = true;
    setSnapshot({ engine, running, meter: EMPTY_ODYSSEY_METER });
    if (!running) return () => { active = false; };

    const unsubscribe = engine.onMeter((nextMeter) => {
      if (!active) return;
      setSnapshot((current) => (
        current.engine === engine
          && current.running
          && odysseyMetersMatch(current.meter, nextMeter)
          ? current
          : { engine, running: true, meter: nextMeter }
      ));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [engine, running]);

  const meter = running && snapshot.running && snapshot.engine === engine
    ? snapshot.meter
    : EMPTY_ODYSSEY_METER;

  return <OutputMeter leftRms={meter.leftRms} rightRms={meter.rightRms} running={running} />;
}

export const LiveOutputMeter = memo(LiveOutputMeterComponent);
