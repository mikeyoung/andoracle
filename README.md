# Andoracle

Andoracle is an installable, offline-capable, touch-first duophonic browser synthesizer whose goal is a faithful functional recreation of the ARP Odyssey's normalized signal flow, playing behavior, and three filter characters—not component-for-component circuit simulation—with clearly separated modern additions including stereo delay, optional MIDI and live input, local named patches and note sequences, and URL sharing. Its audio engine is intentionally fixed at 44.1 kHz.

Play the production version at [mikeyoung.org/andoracle](https://mikeyoung.org/andoracle/).

## Run locally

```sh
npm install
npm run dev
```

Open the printed local URL, press **Power on** to enable audio, then play the on-screen keyboard or the computer-key row beginning with `A`.

## Interaction

- Drag any fader with mouse, pen, or touch.
- Tap a source/routing button to cycle its valid switch positions.
- Right-click a persistent parameter to enter an exact value and see its valid range.
- Long-press a parameter on touch screens for the same direct-entry dialog.
- Open **Help** for a concise guide to every supported way of playing Andoracle.
- Enable **Auto gate** for sound without holding a key.
- Select the transpose-glide revision behavior, original or repaired Type III cutoff scaling, pedal override, and portamento-foot-switch bypass from the panel.
- Use **All notes off** to release every physical note, PPC gesture, and the auto gate.
- Press **Connect MIDI** to authorize compatible USB or Bluetooth MIDI keyboards. All detected inputs are monitored, hot-plugged devices refresh automatically, pitch bend uses the panel bend range, and CC1 modulation uses the panel vibrato depth. MIDI access is optional and requires a browser with Web MIDI support on HTTPS or localhost.
- Use **External audio** to route an audio-interface or microphone input through the mixer, stereo delay, VCF, HPF, and VCA. The browser asks for input permission only when you press it.
- Patch edits save automatically in local storage and are encoded in the URL fragment. Use **Share Patch** (or copy the current browser URL) to share all 80 patch controls; opening it restores the patch without restoring audio power, held notes, or hardware permissions. Factory patches remain available from the header.
- **Save** creates a trimmed, user-named snapshot in this device's local storage, and **Load** restores one from the user patch library. Saved names are unique regardless of capitalization and are never overwritten implicitly. **Delete** removes only the active user-created patch after confirmation while keeping the current controls and URL. Every built-in patch—present and future—is an immutable, undeletable library source; changing its controls creates a separate custom state. If an update adds a built-in name that collides with an older user patch, the user snapshot is preserved under a collision-safe user-copy name.
- The persistent **Record** transport captures keyboard note attacks, releases, and timing only; synth controls, wheels, pedals, and patch changes are excluded. Stop manually or leave all notes released for one minute, then explicitly save/name or discard the take. Saved sequences use compact versioned local storage; entering a trimmed or case-equivalent existing name asks for explicit Cancel/Replace confirmation before overwriting it. **Play** runs or resumes the loaded sequence through the live patch, **Pause** freezes its position, and **Stop** returns it to the beginning; every synth control remains live throughout playback. **Delete** removes the active saved recording after confirmation and safely stops its playback.

## Audio architecture

The worklet contains two band-limited oscillators and one shared subtractive signal path. One held note drives both VCOs; with several held notes, VCO 1 receives the lowest and VCO 2 the highest. A common gate and distinct delayed keyboard trigger preserve Odyssey legato articulation. Portamento retains the common pitch at key release, has selectable early/late transpose behavior, and tops out at the Korg-specified 1.5 s/oct response.

The complete internal-source and optional-live-input mix enters the user-controlled stereo delay before matched left/right instances of the selected resonant low-pass character, manual high-pass, shared VCA control, drive, safety limiter, and master output. An optional output-feedback return models the output-to-external-input patch through that complete downstream path.

The engine requires an actual 44,100 Hz `AudioContext` and reports a clear error instead of running at a different rate.

The shared modulation system includes one LFO, separate raw/held/lagged sample-and-hold signals, keyboard and repeat envelope modes, pedal substitution, hard sync, pulse-width modulation, and comparator-state pulse-XOR ring modulation. Type I, II, and III select calibrated two-pole 4023, transistor-ladder 4035, and Norton-cascade 4075 characters; Type III also offers original limited and repaired full-range scaling.

The full signal chain runs at 2× rate, oscillator discontinuities run at an additional 2× rate, and dedicated FIR decimators suppress hard-sync, pulse, ring, filter, and drive aliases before the required 44.1 kHz output.

## Verification

```sh
npm run check
```

This runs deterministic DSP/schema tests and a production PWA build. The 512×512 `public/icon-master-512.png` is the canonical app-icon artwork; `npm run generate:icons` enforces grayscale pixels and derives the checked-in favicon, Apple-touch, general PWA, and maskable sizes from it. Production builds regenerate those assets automatically.
