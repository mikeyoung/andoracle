import { memo } from "react";

const PANEL_SCREW_CORNERS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;

/** Four decorative fasteners shared by every framed synthesizer panel. */
function PanelScrewsComponent() {
  return (
    <span className="panel-screws" aria-hidden="true">
      {PANEL_SCREW_CORNERS.map((corner) => (
        <i
          key={corner}
          className={`panel-screw panel-screw--${corner}`}
          data-panel-screw={corner}
        />
      ))}
    </span>
  );
}

export const PanelScrews = memo(PanelScrewsComponent);
