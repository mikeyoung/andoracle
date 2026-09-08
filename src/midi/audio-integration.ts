/** The small audio surface needed to recover Andoracle's shared voice after CC120. */
export interface MidiAllSoundOffTarget {
  allSoundOff(): void;
  noteOn(note: number): void;
  resumeSound(): void;
}

/**
 * MIDI channels share one Odyssey voice and delay line. CC120 therefore has to
 * hard-clear that shared DSP, then reconstruct sound still owned by another
 * channel/interface. AUTO and live input are non-note sources, so they need an
 * explicit resume after the remaining note set has been restored.
 */
export const recoverAfterMidiAllSoundOff = (
  target: MidiAllSoundOffTarget,
  remainingNotes: Iterable<number>,
  resumeNonNoteSources: boolean,
): void => {
  target.allSoundOff();
  for (const note of new Set(remainingNotes)) target.noteOn(note);
  if (resumeNonNoteSources) target.resumeSound();
};
