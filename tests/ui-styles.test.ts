import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve("src/console-1968.css"), "utf8");
const baseStyles = readFileSync(resolve("src/styles.css"), "utf8");
const app = readFileSync(resolve("src/App.tsx"), "utf8");
const layout = readFileSync(resolve("src/ui/layout.ts"), "utf8");
const ppc = readFileSync(resolve("src/components/PpcPads.tsx"), "utf8");
const responsiveStyles = styles.slice(
  styles.indexOf("Responsive photographic console assembly"),
);
const photographicStyles = styles.slice(styles.indexOf("Photographic hardware assembly"));
const consolidatedStyles = styles.slice(styles.indexOf("Consolidated control/output plate"));

describe("responsive 1968 photographic console layout", () => {
  it("exposes one edge-to-edge black-walnut substrate through exact ten-pixel plate gaps", () => {
    expect(styles).toMatch(/html\s*\{[\s\S]*?background-image:\s*url\("\.\/assets\/console\/black-walnut-seamless\.webp"\);[\s\S]*?background-repeat:\s*repeat;[\s\S]*?background-size:\s*1880px 1880px;/);
    expect(styles).toMatch(/body\s*\{[\s\S]*?background:\s*transparent;/);
    expect(styles).not.toContain("console-faceplate-photo.png");
    expect(responsiveStyles).toMatch(/\.app-shell\s*\{[\s\S]*?gap:\s*10px;[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;/);
    expect(responsiveStyles).toMatch(/main\s*\{[\s\S]*?gap:\s*10px;[\s\S]*?padding:\s*0;[\s\S]*?background:\s*transparent;/);
    expect(responsiveStyles).toMatch(/\.panel-grid\s*\{[\s\S]*?gap:\s*10px;/);
    expect(responsiveStyles).toMatch(/@media \(max-width:\s*840\.98px\)[\s\S]*?\.panel-grid\s*\{[\s\S]*?gap:\s*10px;/);
    expect(responsiveStyles).toMatch(/:is\([\s\S]*?\.module,[\s\S]*?\)\s*\{[\s\S]*?background-color:\s*transparent;[\s\S]*?background-image:\s*none;/);
    expect(responsiveStyles).toMatch(/border-image-outset:\s*0;[\s\S]*?clip-path:\s*inset\(0\);/);
  });

  it("uses a natural responsive 1880px-max shell with vertical document scrolling", () => {
    expect(app).toContain('<div className="app-shell">');
    expect(app).not.toContain('className="brand-mark"');
    expect(app).not.toContain('<RasterLabel text="A" variant="brand" />');
    expect(app).not.toContain('className="console-stage"');
    expect(app).not.toContain("consoleRef");
    expect(app).not.toContain("attachConsoleViewportScaler");
    expect(responsiveStyles).toMatch(/html,\s*body,\s*#root\s*\{[\s\S]*?height:\s*auto;[\s\S]*?overflow-x:\s*hidden;[\s\S]*?overflow-y:\s*visible;/);
    expect(responsiveStyles).toMatch(/\.app-shell\s*\{[\s\S]*?width:\s*min\(1880px, calc\(100% - 24px\)\);[\s\S]*?max-width:\s*1880px;[\s\S]*?height:\s*auto;[\s\S]*?overflow:\s*visible;[\s\S]*?transform:\s*none;/);
    expect(responsiveStyles).toMatch(/\.brand\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);[\s\S]*?gap:\s*0;[\s\S]*?padding:\s*0 0 0 18px;/);
    expect(responsiveStyles).toMatch(/\.brand-name,\s*\.brand-model\s*\{[\s\S]*?text-align:\s*left;/);
    expect(responsiveStyles).toMatch(/\.brand-name \.raster-label,\s*\.brand-model \.raster-label\s*\{[\s\S]*?justify-content:\s*flex-start;[\s\S]*?text-align:\s*left;/);
    expect(responsiveStyles).not.toMatch(/overflow-x:\s*(?:auto|scroll)/);
  });

  it("keeps the complete instrument in an orthographic overhead view with 50px rotating knobs", () => {
    expect(styles).not.toMatch(/\bperspective\s*:/);
    expect(styles).not.toMatch(/\b(?:rotate[XY3d]|skew[XY]?)\s*\(/);
    expect(styles).not.toMatch(/\bmatrix3d\s*\(/);
    expect(responsiveStyles).toMatch(/\.dial-face,[\s\S]*?width:\s*50px;[\s\S]*?height:\s*50px;[\s\S]*?border-radius:\s*50%;[\s\S]*?transform:\s*rotate\(var\(--dial-angle\)\);/);
    expect(responsiveStyles).toMatch(/\.dial-face i\s*\{[\s\S]*?display:\s*none;/);
    expect(responsiveStyles).toMatch(/\.dial-shell,[\s\S]*?width:\s*56px;[\s\S]*?height:\s*56px;[\s\S]*?margin:\s*4px auto 0;/);
  });

  it("reserves one selector row before every otherwise bare dial in mixed panels", () => {
    expect(responsiveStyles).toMatch(
      /\.control-bank--selector-rows\s*\{[\s\S]*?--selector-row-height:\s*99px;[\s\S]*?--selector-row-spacer-height:\s*101px;[\s\S]*?container-type:\s*inline-size;/,
    );
    expect(responsiveStyles).toMatch(
      /@container \(min-width:\s*224px\)\s*\{[\s\S]*?\.control-bank--selector-rows > \.parameter--range::before\s*\{[\s\S]*?height:\s*var\(--selector-row-spacer-height\);[\s\S]*?flex:\s*0 0 var\(--selector-row-spacer-height\);[\s\S]*?content:\s*"";/,
    );
    expect(responsiveStyles).toMatch(
      /\.control-bank--selector-rows > \.route-control > \.parameter--choice\s*\{[\s\S]*?min-height:\s*var\(--selector-row-height\);[\s\S]*?padding-top:\s*0;[\s\S]*?padding-bottom:\s*4px;/,
    );
    expect(responsiveStyles).toMatch(
      /\.control-bank--selector-rows \.parameter--range > label\s*\{[\s\S]*?min-height:\s*45px;/,
    );
    expect(responsiveStyles).toMatch(
      /\.control-bank--selector-rows > \.route-control \.parameter--range \.dial-shell\s*\{[\s\S]*?margin-top:\s*4px;/,
    );
    expect(responsiveStyles).not.toMatch(
      /\.module--vco2 \.control-bank--selector-rows > \.parameter--range:nth-child\([23]\)::before[\s\S]*?display:\s*none;/,
    );
    expect(responsiveStyles).not.toMatch(
      /\.module--amplifier \.control-bank--selector-rows > \.parameter--range:nth-child\([23]\)::before[\s\S]*?display:\s*none;/,
    );
    expect(responsiveStyles).toMatch(
      /\.module--filter \.control-bank--selector-rows > \.parameter--range:nth-child\(3\)::before\s*\{[\s\S]*?display:\s*none;/,
    );
    expect(responsiveStyles).toMatch(
      /@media \(min-width:\s*360px\)[\s\S]*?\.module\.module--filter > \.control-bank\.control-bank--selector-rows\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(6, minmax\(0, 1fr\)\);/,
    );
    expect(responsiveStyles).toMatch(
      /\.module\.module--filter > \.control-bank\.control-bank--selector-rows\s*\{[\s\S]*?--selector-row-height:\s*84px;[\s\S]*?--selector-row-spacer-height:\s*86px;[\s\S]*?align-content:\s*flex-start;[\s\S]*?padding-top:\s*10px;[\s\S]*?padding-bottom:\s*18px;/,
    );
    expect(responsiveStyles).toMatch(
      /\.module\.module--filter > \.control-bank\.control-bank--selector-rows > \.parameter,[\s\S]*?\.module\.module--filter > \.control-bank\.control-bank--selector-rows > \.route-control\s*\{[\s\S]*?padding-top:\s*4px;[\s\S]*?padding-bottom:\s*4px;/,
    );
    expect(responsiveStyles).toMatch(
      /@container \(min-width:\s*224px\)[\s\S]*?\.module--filter \.control-bank--selector-rows \.parameter--range > label\s*\{[\s\S]*?min-height:\s*32px;/,
    );
    expect(responsiveStyles).toMatch(
      /\.module--filter \.control-bank--selector-rows > \.parameter--range:nth-child\(4\)::before,[\s\S]*?\.parameter--range:nth-child\(5\)::before\s*\{[\s\S]*?display:\s*none;/,
    );
    expect(layout).toMatch(
      /param:\s*"filterCutoff"[\s\S]*?param:\s*"filterResonance"[\s\S]*?param:\s*"hpfCutoff"[\s\S]*?source:\s*"filterMod1Source"[\s\S]*?source:\s*"filterMod3Source"/,
    );
  });

  it("centers every module header and complete wrapped control row", () => {
    const centeringStart = responsiveStyles.indexOf(
      "Center the complete contents of every synthesis module",
    );
    const centering = responsiveStyles.slice(
      centeringStart,
      responsiveStyles.indexOf("@media (forced-colors: active)", centeringStart),
    );

    expect(centeringStart).toBeGreaterThanOrEqual(0);
    expect(centering).toMatch(
      /\.module-header\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);[\s\S]*?justify-items:\s*center;[\s\S]*?text-align:\s*center;/,
    );
    expect(centering).toMatch(
      /\.module > \.control-bank\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?justify-content:\s*center;/,
    );
    expect(centering).toMatch(
      /\.module > \.control-bank > \*\s*\{[\s\S]*?max-width:\s*190px;[\s\S]*?flex:\s*1 1 112px;/,
    );
    expect(centering).toMatch(
      /\.module--vco1 > \.control-bank > :first-child\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*none;[\s\S]*?flex:\s*0 0 100%;/,
    );
    expect(centering).toMatch(
      /\.module--vco1 > \.control-bank > :first-child \.choice-button\s*\{[\s\S]*?width:\s*min\(190px, calc\(100% - 4px\)\);[\s\S]*?margin-right:\s*auto;[\s\S]*?margin-left:\s*auto;/,
    );
    expect(centering).toMatch(
      /@media \(min-width:\s*1451px\)[\s\S]*?\.module--envelopes \.control-bank\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(20, minmax\(0, 1fr\)\);/,
    );
  });

  it("reflows modules from the desktop signal-path grid through dense tablet and mobile layouts", () => {
    expect(responsiveStyles).toMatch(/\.panel-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(12, minmax\(0, 1fr\)\);[\s\S]*?grid-auto-flow:\s*row;/);
    expect(responsiveStyles).toMatch(/\.module--controllers,\s*\.module--vco1,\s*\.module--vco2\s*\{[\s\S]*?grid-column:\s*span 4;/);
    expect(responsiveStyles).toMatch(/\.module--modulators,\s*\.module--mixer,\s*\.module--delay,\s*\.module--filter\s*\{[\s\S]*?grid-column:\s*span 3;/);
    expect(responsiveStyles).toMatch(/\.module--envelopes\s*\{[\s\S]*?grid-column:\s*span 7;/);
    expect(responsiveStyles).toMatch(/\.module--amplifier\s*\{[\s\S]*?grid-column:\s*span 5;/);

    const twoColumn = responsiveStyles.slice(
      responsiveStyles.indexOf("@media (max-width: 1450.98px)"),
      responsiveStyles.indexOf("@media (max-width: 919px)"),
    );
    expect(twoColumn).toMatch(/\.module--controllers,[\s\S]*?\.module--amplifier\s*\{[\s\S]*?grid-column:\s*span 6;/);

    const oneColumn = responsiveStyles.slice(
      responsiveStyles.indexOf("@media (max-width: 840.98px)"),
      responsiveStyles.indexOf("@media (max-width: 760px)"),
    );
    expect(oneColumn).toMatch(/\.module--controllers,[\s\S]*?\.module--amplifier\s*\{[\s\S]*?grid-column:\s*1 \/ -1;/);

    const landscapeTablet = responsiveStyles.slice(
      responsiveStyles.indexOf("@media (min-width: 1280px) and (max-width: 1450.98px)"),
      responsiveStyles.indexOf("@media (min-width: 841px) and (max-width: 1450.98px)"),
    );
    expect(landscapeTablet).toMatch(/\.module--controllers,[\s\S]*?\.module--amplifier\s*\{[\s\S]*?grid-column:\s*span 4;/);
  });

  it("uses deterministic control density without shrinking the approved hardware", () => {
    const tablet = responsiveStyles.slice(
      responsiveStyles.indexOf("@media (min-width: 841px) and (max-width: 1450.98px)"),
      responsiveStyles.indexOf("@media (min-width: 1040px) and (max-width: 1279.98px)"),
    );
    expect(tablet).toMatch(/grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/);
    expect(tablet).toMatch(/gap:\s*6px;/);
    expect(tablet).toMatch(/padding-right:\s*12px;[\s\S]*?padding-left:\s*12px;/);

    const midTablet = responsiveStyles.slice(
      responsiveStyles.indexOf("@media (min-width: 1040px) and (max-width: 1279.98px)"),
      responsiveStyles.indexOf("@media (min-width: 1280px) and (max-width: 1450.98px)", responsiveStyles.indexOf("@media (min-width: 1040px)")),
    );
    expect(midTablet).toMatch(/grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/);

    const mobile = responsiveStyles.slice(
      responsiveStyles.indexOf("@media (max-width: 840.98px)"),
      responsiveStyles.indexOf("@media (max-width: 880px)", responsiveStyles.indexOf("@media (max-width: 840.98px)")),
    );
    expect(mobile).toMatch(/grid-template-columns:\s*repeat\(auto-fit, minmax\(108px, 1fr\)\);/);
    expect(mobile).toMatch(/padding-right:\s*16px;[\s\S]*?padding-left:\s*16px;/);
    expect(responsiveStyles).toMatch(/\.parameter,\s*\.parameter:last-child,\s*\.route-control\s*\{[\s\S]*?padding:\s*6px 2px;/);
    expect(ppc).toContain('const PPC_PAD_KINDS = ["down", "vibrato", "up"] as const;');
    expect(responsiveStyles).toMatch(/\.ppc-pad > b\s*\{[^}]*transform:\s*translateY\(2px\);/);
    const stackedPpc = responsiveStyles.slice(
      responsiveStyles.indexOf("@media (max-width: 1450.98px)"),
      responsiveStyles.indexOf("@media (min-width: 1280px) and (max-width: 1450.98px)"),
    );
    expect(stackedPpc).not.toMatch(
      /\.module--controllers \.ppc-pad--(?:down|vibrato|up)\s*\{[^}]*\border\s*:/,
    );
  });

  it("uses the widest desktop module sequence as the canonical order at every width", () => {
    const desktopStart = responsiveStyles.indexOf(".module--controllers { order: 1; }");
    const desktopEnd = responsiveStyles.indexOf("@media (min-width: 1451px)", desktopStart);
    const desktop = responsiveStyles.slice(desktopStart, desktopEnd);

    expect(desktopStart).toBeGreaterThanOrEqual(0);
    expect(desktop).toMatch(/\.module--controllers\s*\{\s*order:\s*1;/);
    expect(desktop).toMatch(/\.module--vco1\s*\{\s*order:\s*2;/);
    expect(desktop).toMatch(/\.module--vco2\s*\{\s*order:\s*3;/);
    expect(desktop).toMatch(/\.module--envelopes\s*\{\s*order:\s*4;/);
    expect(desktop).toMatch(/\.module--amplifier\s*\{\s*order:\s*5;/);
    expect(desktop).toMatch(/\.module--modulators\s*\{\s*order:\s*6;/);
    expect(desktop).toMatch(/\.module--filter\s*\{\s*order:\s*7;/);
    expect(desktop).toMatch(/\.module--mixer\s*\{\s*order:\s*8;/);
    expect(desktop).toMatch(/\.module--delay\s*\{\s*order:\s*9;/);

    const allModuleOrderRules = [...styles.matchAll(
      /\.module--(?:controllers|vco1|vco2|envelopes|amplifier|modulators|filter|mixer|delay)\s*\{[^}]*\border\s*:/g,
    )];
    expect(allModuleOrderRules).toHaveLength(9);

    const descendantOrderRules = [...styles.matchAll(
      /\.module--(?:controllers|vco1|vco2|envelopes|amplifier|modulators|filter|mixer|delay)\s+[^,{]+\{[^}]*\border\s*:/g,
    )];
    expect(descendantOrderRules).toHaveLength(0);

    const narrower = responsiveStyles.slice(
      responsiveStyles.indexOf("@media (max-width: 1450.98px)"),
      responsiveStyles.indexOf("@media (min-width: 1280px) and (max-width: 1450.98px)"),
    );
    const responsiveModuleRules = [...narrower.matchAll(
      /\.module--(?:controllers|vco1|vco2|envelopes|amplifier|modulators|filter|mixer|delay)\s*\{([^}]*)\}/g,
    )];
    expect(responsiveModuleRules.some((match) => /\border\s*:/.test(match[1]))).toBe(false);
    expect(baseStyles).not.toMatch(
      /\.module--(?:controllers|vco1|vco2|envelopes|amplifier|modulators|filter|mixer|delay)\s*\{[^}]*\border\s*:/,
    );
  });

  it("keeps DOM, visual, and keyboard-focus module order identical before the bottom keyboard", () => {
    const sectionOrder = [
      "controllers",
      "vco1",
      "vco2",
      "envelopes",
      "amplifier",
      "modulators",
      "filter",
      "mixer",
      "delay",
    ];
    let previous = -1;
    for (const id of sectionOrder) {
      const next = layout.indexOf('id: "' + id + '"');
      expect(next).toBeGreaterThan(previous);
      previous = next;
    }

    const keyboardDefinition = app.indexOf("const keyboardModule = (");
    const keyboard = app.indexOf("<Keyboard", keyboardDefinition);
    const headerControl = app.indexOf("headerControl={midiHeaderControl}", keyboard);
    const mainStart = app.indexOf('<main ref={performanceFocusRef} tabIndex={-1}>');
    const topPlacement = app.indexOf('{keyboardPosition === "top" && keyboardModule}', mainStart);
    const panelGrid = app.indexOf('className="panel-grid"', topPlacement);
    const bottomPlacement = app.indexOf('{keyboardPosition === "bottom" && keyboardModule}', panelGrid);
    const mainClose = app.indexOf("</main>", bottomPlacement);
    expect(keyboardDefinition).toBeGreaterThanOrEqual(0);
    expect(keyboard).toBeGreaterThan(keyboardDefinition);
    expect(headerControl).toBeGreaterThan(keyboard);
    expect(topPlacement).toBeGreaterThan(mainStart);
    expect(panelGrid).toBeGreaterThan(topPlacement);
    expect(bottomPlacement).toBeGreaterThan(panelGrid);
    expect(mainClose).toBeGreaterThan(bottomPlacement);
    expect(app).toContain("const midiHeaderControl = useMemo(() => (");
    expect(app).not.toMatch(/<\/div>\s*<MidiInputControl[\s\S]*?<Keyboard/);
    expect(app).not.toContain("<footer");
    expect(responsiveStyles).toMatch(/\.keyboard-module\s*\{[\s\S]*?grid-template-rows:\s*auto auto;/);
    expect(responsiveStyles).toMatch(/\.keyboard-header\s*\{[\s\S]*?grid-template-columns:\s*minmax\(320px, 0\.9fr\) auto minmax\(0, 1\.6fr\);/);
    expect(responsiveStyles).toMatch(/\.keyboard-header-actions\s*\{[\s\S]*?display:\s*flex;[\s\S]*?justify-self:\s*center;/);
    expect(responsiveStyles).toMatch(/\.keyboard-position-picker\s*\{[\s\S]*?grid-template-columns:\s*auto 112px;/);
    expect(responsiveStyles).toMatch(/\.keyboard-banks\s*\{[\s\S]*?padding:\s*5px 8px 0;/);
    expect(responsiveStyles).not.toContain(".keyboard-footer");
    expect(responsiveStyles).toMatch(/\.midi-control__launcher\s*\{[\s\S]*?min-height:\s*44px;/);
  });

  it("wraps the utility, patch, and sequence rows as complete balanced groups", () => {
    expect(consolidatedStyles).toMatch(/\.topbar > \.library-deck\s*\{[\s\S]*?grid-template-rows:\s*repeat\(3, 44px\);[\s\S]*?gap:\s*8px;/);
    expect(consolidatedStyles).toMatch(/\.topbar \.utility-strip\s*\{[\s\S]*?padding-left:\s*calc\(var\(--library-label-column\) \+ var\(--library-row-gap\)\);/);
    expect(consolidatedStyles).toMatch(/\.topbar \.library-actions\s*\{[\s\S]*?display:\s*flex;[\s\S]*?justify-content:\s*flex-start;/);
    expect(consolidatedStyles).toMatch(/@media \(max-width:\s*590px\)[\s\S]*?\.topbar \.utility-strip,[\s\S]*?flex-wrap:\s*wrap;/);
    const singleColumnHeader = consolidatedStyles.slice(
      consolidatedStyles.indexOf("@media (max-width: 919px)"),
      consolidatedStyles.indexOf("@media (max-width: 590px)"),
    );
    expect(singleColumnHeader).toMatch(/\.topbar > \.library-deck\s*\{[\s\S]*?grid-template-rows:\s*repeat\(3, auto\);[\s\S]*?justify-items:\s*center;/);
    expect(singleColumnHeader).toMatch(/\.topbar \.utility-strip,\s*\.topbar \.patch-strip,\s*\.topbar \.sequence-strip\s*\{[\s\S]*?height:\s*auto;[\s\S]*?justify-content:\s*center;[\s\S]*?flex-wrap:\s*wrap;/);
    expect(singleColumnHeader).toMatch(/\.topbar \.utility-strip\s*\{[^}]*padding-left:\s*0;/);
  });

  it("consolidates identity, three control rows, and full-height output meters", () => {
    expect(consolidatedStyles).toMatch(/\.topbar\s*\{[\s\S]*?height:\s*200px;[\s\S]*?grid-template-columns:\s*minmax\(200px, 230px\) minmax\(0, 1fr\) minmax\(300px, 420px\);/);
    expect(consolidatedStyles).toMatch(/\.topbar \.brand-name \.raster-label--brand\s*\{[^}]*font-size:\s*17px;/);
    expect(consolidatedStyles).toMatch(/\.topbar \.brand-model \.raster-label--model\s*\{[^}]*font-size:\s*12px;/);
    expect(consolidatedStyles).toMatch(/\.topbar \.library-select-shell\s*\{[\s\S]*?max-width:\s*300px;/);
    expect(consolidatedStyles).toMatch(/\.topbar \.button:not\(\.sequence-icon-button\)\s*\{[\s\S]*?width:\s*max-content;[\s\S]*?padding-right:\s*10px;[\s\S]*?padding-left:\s*10px;/);
    expect(consolidatedStyles).toMatch(/\.topbar > \.output-meter\s*\{[\s\S]*?justify-self:\s*end;[\s\S]*?max-width:\s*400px;[\s\S]*?min-height:\s*169px;[\s\S]*?overflow:\s*visible;/);
    expect(consolidatedStyles).toMatch(/\.topbar > \.output-meter \.output-vu-meter\s*\{[\s\S]*?overflow:\s*visible;/);
    expect(styles).not.toContain(".status-deck");
    expect(styles).not.toContain(".usage-note");
  });

  it("gives library dropdown text and arrows matching bezel clearance", () => {
    expect(responsiveStyles).toMatch(
      /\.library-select-shell::before\s*\{[\s\S]*?border:\s*7px solid transparent;[\s\S]*?border-image-slice:\s*88 fill;[\s\S]*?border-image-width:\s*7px;/,
    );
    expect(responsiveStyles).toMatch(
      /\.library-select-shell::after\s*\{[\s\S]*?right:\s*14px;[\s\S]*?width:\s*11px;[\s\S]*?background:[\s\S]*?selector-arrow-photo\.png/,
    );
    expect(responsiveStyles).toMatch(
      /\.patch-strip select,\s*\.sequence-strip select,\s*\.library-picker select\s*\{[\s\S]*?padding:\s*6px 36px 6px 14px;[\s\S]*?background:\s*transparent;/,
    );
    expect(consolidatedStyles).toMatch(/\.topbar \.library-select-shell\s*\{[\s\S]*?width:\s*min\(300px, 100%\);[\s\S]*?max-width:\s*300px;/);
  });

  it("renders switches at twice the old photographic actuator size", () => {
    expect(responsiveStyles).toMatch(/\.toggle-switch\s*\{[\s\S]*?width:\s*104px;[\s\S]*?height:\s*122px;[\s\S]*?flex-direction:\s*column;/);
    expect(responsiveStyles).toMatch(/\.toggle-switch > span:not\(\.raster-label\),[\s\S]*?width:\s*92px;[\s\S]*?height:\s*96px;[\s\S]*?background-size:\s*contain;/);
    expect(responsiveStyles).toMatch(/\.power-switch\s*\{[\s\S]*?width:\s*184px;[\s\S]*?height:\s*104px;[\s\S]*?flex-direction:\s*row;/);
    expect(responsiveStyles).toMatch(/\.power-switch > span:not\(\.raster-label\)\s*\{[\s\S]*?width:\s*96px;[\s\S]*?height:\s*96px;[\s\S]*?transform:\s*rotate\(90deg\);/);
    expect(consolidatedStyles).toMatch(/\.console-identity-area \.power-control\s*\{[\s\S]*?grid-template-rows:\s*auto 96px;[\s\S]*?gap:\s*10px;/);
    expect(consolidatedStyles).toMatch(/\.console-identity-area \.power-switch\s*\{[\s\S]*?width:\s*160px;[\s\S]*?height:\s*96px;[\s\S]*?gap:\s*10px;/);
    expect(consolidatedStyles).toMatch(/\.console-identity-area \.power-switch b\s*\{[\s\S]*?width:\s*22px;[\s\S]*?flex-basis:\s*22px;/);
    expect(consolidatedStyles).toMatch(/\.console-identity-area \.power-strip\s*\{[\s\S]*?border:\s*0;/);
    expect(consolidatedStyles).not.toMatch(/\.console-identity-area \.power-strip\s*\{[^}]*border-(?:top|left):/);
    const responsiveIdentity = consolidatedStyles.slice(
      consolidatedStyles.indexOf("@media (max-width: 919px)"),
      consolidatedStyles.indexOf("@media (max-width: 590px)"),
    );
    expect(responsiveIdentity).toMatch(/\.console-identity-area \.power-strip\s*\{[\s\S]*?padding-left:\s*0;[\s\S]*?border:\s*0;/);
  });

  it("places intrinsic-height control labels directly above their dials and values", () => {
    expect(responsiveStyles).toMatch(/\.parameter label,[\s\S]*?min-height:\s*32px;[\s\S]*?align-items:\s*flex-end;[\s\S]*?overflow:\s*visible;/);
    expect(responsiveStyles).toMatch(/@media \(min-width:\s*1451px\)[\s\S]*?\.module--controllers \.parameter > label,[\s\S]*?\.module--controllers \.toggle-label\s*\{[\s\S]*?min-height:\s*45px;/);
    expect(responsiveStyles).toMatch(/\.parameter output,[\s\S]*?min-height:\s*18px;[\s\S]*?height:\s*auto;[\s\S]*?font-size:\s*12px;/);
    expect(responsiveStyles).toMatch(/\.choice-button,[\s\S]*?min-height:\s*44px;[\s\S]*?height:\s*auto;[\s\S]*?overflow:\s*visible;/);
    expect(responsiveStyles).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(responsiveStyles).not.toMatch(/line-clamp/);
  });

  it("uses one keyboard row from 600px, two rows at 481–599px, and three through 480px", () => {
    expect(responsiveStyles).toMatch(/\.keyboard-surface\s*\{[\s\S]*?display:\s*contents;/);
    expect(responsiveStyles).toMatch(/\.piano-key\s*\{[\s\S]*?left:\s*var\(--desktop-key-left\);[\s\S]*?width:\s*var\(--desktop-key-width\);/);

    const twoRow = responsiveStyles.slice(
      responsiveStyles.indexOf("@media (max-width: 919px)"),
      responsiveStyles.indexOf("@media (max-width: 840.98px)"),
    );
    expect(twoRow).toMatch(/\.keyboard-banks\s*\{[\s\S]*?grid-template-rows:\s*repeat\(2, var\(--keyboard-row-height\)\);/);
    expect(twoRow).toMatch(/\.piano-key\s*\{[\s\S]*?left:\s*var\(--two-row-key-left\);[\s\S]*?width:\s*var\(--two-row-key-width\);/);

    const threeRow = responsiveStyles.slice(
      responsiveStyles.indexOf("@media (max-width: 480px)"),
      responsiveStyles.indexOf("@media (max-width: 360px)"),
    );
    expect(threeRow).toMatch(/\.keyboard-banks\s*\{[\s\S]*?grid-template-rows:\s*repeat\(3, var\(--keyboard-row-height\)\);/);
    expect(threeRow).toMatch(/\.piano-key\s*\{[\s\S]*?left:\s*var\(--three-row-key-left\);[\s\S]*?width:\s*var\(--three-row-key-width\);/);

    const oneRow600 = responsiveStyles.slice(
      responsiveStyles.indexOf("@media (min-width: 600px) and (max-width: 919px)"),
      responsiveStyles.indexOf("The old fixed canvas intentionally miniaturized"),
    );
    expect(oneRow600).toMatch(/\.keyboard-banks\s*\{[\s\S]*?grid-template-rows:\s*var\(--keyboard-row-height\);[\s\S]*?gap:\s*0;/);
    expect(oneRow600).toMatch(/\.keyboard-surface\s*\{[\s\S]*?display:\s*contents;/);
    expect(oneRow600).toMatch(/\.piano-key\s*\{[\s\S]*?left:\s*var\(--desktop-key-left\);[\s\S]*?width:\s*var\(--desktop-key-width\);/);
    expect(oneRow600).toMatch(/\.piano-key--white\s*\{[^}]*height:\s*calc\(var\(--keyboard-row-height\) - 5px\);/);
    expect(responsiveStyles).toMatch(/\.piano-key--black\s*\{[\s\S]*?0\.62/);
  });

  it("preserves circular corner fasteners while photographic panel plates stretch", () => {
    expect(responsiveStyles).toMatch(/border-image-source:\s*url\("\.\/assets\/console\/panel-blank-photo\.png"\);[\s\S]*?border-image-slice:\s*150 fill;[\s\S]*?border-image-repeat:\s*stretch;/);
    expect(responsiveStyles).toMatch(/\.panel-screw\s*\{[\s\S]*?width:\s*13px;[\s\S]*?height:\s*13px;[\s\S]*?aspect-ratio:\s*1;[\s\S]*?border-radius:\s*50%;/);
    expect(responsiveStyles).toMatch(/\.panel-screws\s*\{[\s\S]*?--panel-screw-offset:\s*11px;/);
    expect(baseStyles).toContain("top: var(--panel-screw-offset)");
    expect(baseStyles).toContain("right: var(--panel-screw-offset)");
    expect(baseStyles).toContain("bottom: var(--panel-screw-offset)");
    expect(baseStyles).toContain("left: var(--panel-screw-offset)");
  });

  it("keeps the consolidated plate and footer content clear of photographic screws", () => {
    expect(consolidatedStyles).toMatch(/\.topbar\s*\{[\s\S]*?padding:\s*10px 22px;/);
    expect(responsiveStyles).toMatch(
      /footer\s*\{[\s\S]*?gap:\s*8px 20px;[\s\S]*?padding:\s*12px 32px;/,
    );
  });

  it("keeps focus, transport, and duophonic allocation states visibly distinct", () => {
    expect(styles).toMatch(/\.control-bank button:focus-visible\s*\{[\s\S]*?outline:\s*2px solid #171713;[\s\S]*?outline-offset:\s*-4px;/);
    expect(photographicStyles).toMatch(/\.sequence-pause-button i\s*\{[\s\S]*?background:\s*linear-gradient\([\s\S]*?transparent 35% 65%/);
    expect(photographicStyles).toMatch(/\.sequence-pause-button\.is-active:disabled\s*\{[\s\S]*?opacity:\s*1;/);
    expect(photographicStyles).toMatch(/\.piano-key\.is-low\s*\{[\s\S]*?box-shadow:\s*inset/);
    expect(photographicStyles).toMatch(/\.piano-key\.is-high\s*\{[\s\S]*?box-shadow:\s*inset/);
    expect(photographicStyles).toMatch(/\.piano-key\.is-low\.is-high\s*\{[\s\S]*?box-shadow:/);
  });

  it("keeps transient overlays outside the responsive console shell", () => {
    const shellClose = app.indexOf("</main>\n      </div>");
    const toast = app.indexOf("{clipboardToast && (", shellClose);
    const banner = app.indexOf("{audioStatus.error && (", shellClose);
    expect(shellClose).toBeGreaterThanOrEqual(0);
    expect(toast).toBeGreaterThan(shellClose);
    expect(banner).toBeGreaterThan(shellClose);
    expect(styles).toMatch(/\.system-banner\s*\{[\s\S]*?position:\s*fixed;/);
  });
});
