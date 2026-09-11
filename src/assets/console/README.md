# Andoracle console image assets

These raster assets implement Andoracle's responsive late-1960s instrument. Individual enamel plates and photographic hardware mount directly over one edge-to-edge black-walnut work surface; labels, values, and application status remain selectable system text.

## Generated assets

- `black-walnut-seamless.webp`: large, seamless top-down American black-walnut veneer beneath every plate. Prompt intent: deep espresso and dark chocolate late-1960s walnut, restrained satin finish, diffuse light, fine horizontal grain, and no boards, hardware, borders, text, or focal knots. A deterministic four-quadrant mirror makes its opposite edges meet pixel-for-pixel.
- `walnut-seamless.webp`: retained medium-walnut predecessor for source history and rollback; it is not used by the current console skin.
- `enamel-white.webp`: seamless warm off-white baked-enamel material used by internal hardware details. Prompt intent: top-down photorealistic aged ivory painted metal with restrained orange-peel texture, no controls or text.
- `phenolic-black.webp`: seamless black phenolic control-surface texture. Prompt intent: late-1960s laboratory/synthesizer material, subdued wear, no controls or text.
- `screw-nickel.png`: isolated top-down nickel slotted screw on transparency, evenly lit.
- `panel-blank-photo.png`: isolated enamel hardware plate used once per module, header, status area, keyboard, footer, and transient plate. Its nine-slice corners preserve four circular fasteners at every responsive size.
- `button-phenolic-up.png` and `button-phenolic-square.png`: isolated blank black phenolic pushbuttons and nickel bezels used beneath rendered labels and transport icons.
- `selector-arrow-photo.png`: isolated screen-printed selector arrow used on choice controls.
- `dial-scale-photo.png`: isolated thirteen-mark screen-printed rotary scale with no circular ring.
- `key-white-photo.png`, `key-white-photo-b.png`, and `key-black-photo.png`: isolated overhead photographs of aged synthesizer key caps. Alternating white-key photographs prevent obviously repeated wear.
- `knob-ivory.png`: isolated warm-ivory phenolic 1960s instrumentation knob with one uninterrupted smooth cylindrical body, softly rounded perimeter, honest material grain, and a baked matte-black indicator line. It has no outer ring, lip, groove, ridge, or knurling. Prompt intent: strict orthographic overhead geometry and diffuse coaxial lighting without a specular reflection. The complete raster rotates as one control.

The photographic assets were generated specifically for this project. Transparent cutouts are losslessly cropped to their visible bounds by `scripts/crop-console-photo-assets.ps1`; the square rotary assets retain their original canvases so they remain circular when rotated. No machine-local generation paths are embedded in project metadata.

The repeating material textures use deterministic mirroring after generation so opposite edges meet continuously at their fixed physical texture scales.

## Switch provenance

The four `switches/switch-*-stop.png` and `switches/switch-*-go.png` pairs are copied from the user-provided Chaotic Sound Effects project. They are the requested photographic controls: `stop` is OFF/down and `go` is ON/up. Those images retain the media terms documented by their source project.

## VU meter provenance

`vu-meter-face.png` and `vu-meter-face-off.png` are byte-for-byte copies of the
illuminated and unlit 698×260 dual VU meter faces in the user-provided Chaotic
Sound Effects project. Andoracle also preserves that project's canvas needle
geometry, red needle tips, RMS calibration, and damped moving-coil response;
only the responsive display scale and telemetry source differ. These images
retain the media terms documented by their source project and in the root
`MEDIA-NOTICE.md`.
