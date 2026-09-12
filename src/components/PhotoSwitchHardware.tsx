import delayGo from "../assets/console/switches/switch-delay-go.png";
import delayStop from "../assets/console/switches/switch-delay-stop.png";
import powerGo from "../assets/console/switches/switch-power-go.png";
import powerStop from "../assets/console/switches/switch-power-stop.png";
import synthGo from "../assets/console/switches/switch-synth-go.png";
import synthStop from "../assets/console/switches/switch-synth-stop.png";
import tapesGo from "../assets/console/switches/switch-tapes-go.png";
import tapesStop from "../assets/console/switches/switch-tapes-stop.png";

export type PhotoSwitchVariant = "power" | "tapes" | "synth" | "delay";

const PHOTO_SWITCH_IMAGES: Record<PhotoSwitchVariant, readonly [string, string]> = {
  power: [powerStop, powerGo],
  tapes: [tapesStop, tapesGo],
  synth: [synthStop, synthGo],
  delay: [delayStop, delayGo],
};

interface PhotoSwitchHardwareProps {
  enabled: boolean;
  variant: PhotoSwitchVariant;
}

/**
 * A real image node for photographed switch hardware.
 *
 * Firefox mobile and forced-color implementations may suppress decorative
 * CSS background images. Keeping the actuator as content makes the control
 * visible without changing its semantic button or photographic styling.
 */
export function PhotoSwitchHardware({ enabled, variant }: PhotoSwitchHardwareProps) {
  return (
    <img
      className="photo-switch-hardware"
      src={PHOTO_SWITCH_IMAGES[variant][enabled ? 1 : 0]}
      alt=""
      aria-hidden="true"
      draggable={false}
      width={256}
      height={256}
    />
  );
}
