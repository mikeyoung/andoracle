import { memo } from "react";

export type RasterLabelVariant =
  | "brand"
  | "model"
  | "title"
  | "eyebrow"
  | "control"
  | "button"
  | "micro";

export type RasterLabelTone = "ink" | "muted" | "reverse";

interface RasterLabelProps {
  text: string;
  variant?: RasterLabelVariant;
  tone?: RasterLabelTone;
  preserveCase?: boolean;
  className?: string;
}

/**
 * Semantic faceplate typography.
 *
 * The historical component name remains part of the public UI API, but its
 * label is ordinary system text. Keeping one visible text node avoids the
 * duplicate rendering path that previously exposed the label separately to
 * sighted and assistive users. Default capitalization is a visual CSS
 * treatment, so assistive technology still receives the author's exact text.
 */
function RasterLabelComponent({
  text,
  variant = "control",
  tone = "ink",
  preserveCase = false,
  className,
}: RasterLabelProps) {
  const classes = [
    "raster-label",
    `raster-label--${variant}`,
    `raster-label--tone-${tone}`,
    preserveCase ? "raster-label--preserve-case" : null,
    className || null,
  ].filter((value): value is string => value !== null);

  return (
    <span className={classes.join(" ")}>
      <span className="raster-label__text">{text}</span>
    </span>
  );
}

export const RasterLabel = memo(RasterLabelComponent);
