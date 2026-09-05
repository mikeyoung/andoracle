import { useEffect, useRef } from "react";
import { FACTORY_PRESETS } from "../synth/presets";
import { userPatchNameKey, type UserPatch } from "../synth/user-patches";
import { DeferredSelectFocusRelease, type SelectInteractionModality } from "./select-focus";

const USER_PATCH_OPTION_PREFIX = "__andoracle_user_patch__:";

interface PatchSelectorProps {
  userPatches: readonly UserPatch[];
  activeUserPatchName: string | null;
  selectedFactoryName: string;
  onSelectUserPatch: (name: string) => void;
  onSelectFactoryPatch: (name: string) => void;
}

export const userPatchOptionValue = (name: string): string => (
  `${USER_PATCH_OPTION_PREFIX}${userPatchNameKey(name)}`
);

export type ResolvedPatchSelection =
  | { readonly kind: "user"; readonly patch: UserPatch }
  | { readonly kind: "factory"; readonly name: string };

export const resolvePatchSelection = (
  value: string,
  userPatches: readonly UserPatch[],
): ResolvedPatchSelection | null => {
  if (!value.startsWith(USER_PATCH_OPTION_PREFIX)) {
    return { kind: "factory", name: value };
  }
  const patch = userPatches.find((candidate) => userPatchOptionValue(candidate.name) === value);
  return patch ? { kind: "user", patch } : null;
};

/** Persistent selector for immutable factory patches and every local user patch. */
export function PatchSelector({
  userPatches,
  activeUserPatchName,
  selectedFactoryName,
  onSelectUserPatch,
  onSelectFactoryPatch,
}: PatchSelectorProps) {
  const interactionModality = useRef<SelectInteractionModality>("keyboard");
  const focusRelease = useRef<DeferredSelectFocusRelease | null>(null);
  focusRelease.current ??= new DeferredSelectFocusRelease();
  useEffect(() => () => focusRelease.current?.dispose(), []);
  const activeUserPatch = activeUserPatchName
    ? userPatches.find(
      (patch) => userPatchNameKey(patch.name) === userPatchNameKey(activeUserPatchName),
    )
    : undefined;
  const selectedValue = activeUserPatch
    ? userPatchOptionValue(activeUserPatch.name)
    : selectedFactoryName;

  return (
    <select
      id="preset"
      aria-label="Patch"
      value={selectedValue}
      onPointerDown={() => {
        interactionModality.current = "pointer";
      }}
      onKeyDown={() => {
        interactionModality.current = "keyboard";
      }}
      onChange={(event) => {
        const selection = resolvePatchSelection(event.currentTarget.value, userPatches);
        if (selection?.kind === "user") onSelectUserPatch(selection.patch.name);
        else if (selection?.kind === "factory") onSelectFactoryPatch(selection.name);
        focusRelease.current?.finish(event.currentTarget, interactionModality.current);
        interactionModality.current = "keyboard";
      }}
    >
      <option value="Custom patch">Custom patch</option>
      {userPatches.length > 0 && (
        <optgroup label="Custom Patches">
          {userPatches.map((patch) => (
            <option
              key={userPatchOptionValue(patch.name)}
              value={userPatchOptionValue(patch.name)}
            >
              {patch.name}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="Factory patches">
        {FACTORY_PRESETS.map((preset) => (
          <option key={preset.name} value={preset.name}>{preset.name}</option>
        ))}
      </optgroup>
    </select>
  );
}
