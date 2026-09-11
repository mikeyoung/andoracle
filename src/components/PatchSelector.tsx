import { memo, useEffect, useRef } from "react";
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
function PatchSelectorComponent({
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
    <div className="library-select-shell">
      <select
        id="preset"
        aria-label="Patch"
        value={selectedValue}
        onPointerDown={() => {
          focusRelease.current?.dispose();
          interactionModality.current = "pointer";
        }}
        onKeyDown={(event) => {
          // Escape/Enter/Arrow events can be delivered while a pointer-opened
          // native picker is active. Keep pointer modality until that picker
          // actually closes so choosing the current option still returns note
          // keys to the playable page.
          if (focusRelease.current?.hasPointerFocusReleasePending) return;
          // Engines predating select:open cannot expose a no-change picker
          // close, but Escape is observable and safe to release after its
          // native close default has run.
          if (interactionModality.current === "pointer" && event.key === "Escape") {
            focusRelease.current?.finish(event.currentTarget, "pointer");
            return;
          }
          focusRelease.current?.dispose();
          interactionModality.current = "keyboard";
        }}
        onClick={(event) => {
          if (interactionModality.current === "pointer") {
            focusRelease.current?.watchPointerPicker(event.currentTarget);
          }
        }}
        onChange={(event) => {
          const selection = resolvePatchSelection(event.currentTarget.value, userPatches);
          if (selection?.kind === "user") onSelectUserPatch(selection.patch.name);
          else if (selection?.kind === "factory") onSelectFactoryPatch(selection.name);
          focusRelease.current?.finish(event.currentTarget, interactionModality.current);
          interactionModality.current = "keyboard";
        }}
      >
        {/* This is a state indicator, not a loadable preset. Keeping it in the
            list lets the controlled select display unsaved controls; disabling
            it prevents a selectable option whose handler can only no-op. */}
        <option value="Custom patch" disabled>Custom patch</option>
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
    </div>
  );
}

export const PatchSelector = memo(PatchSelectorComponent);
