# AMO Review Note — "Unsafe assignment to innerHTML" (false positive)

## Summary for reviewers

The Firefox add-on validator reports two warnings:

> Unsafe assignment to innerHTML
> assets/index-BlrAGk_W.js line 9 column 1792
> assets/index-BlrAGk_W.js line 9 column 4661

Both occurrences are **inside the bundled React DOM library**, not in Andoracle's application code. They are the two `A.innerHTML = t` statements that make up React's internal implementation of the `dangerouslySetInnerHTML` prop handler (one for the initial mount path, one for the update path). This is standard, unmodified React 19 output and appears in every React-based bundle.

## Why this is safe

- **No application code assigns to `innerHTML`.** A full search of the source tree (`src/`) finds zero occurrences of `innerHTML`, `insertAdjacentHTML`, `outerHTML`, `document.write`, or a `dangerouslySetInnerHTML` prop. All user-generated content (patch names, sequence names, MIDI device names) is rendered through React's normal text children, which are escaped automatically.
- **The flagged handler never runs with dynamic data.** The two `innerHTML = t` statements only execute if the application passes a `dangerouslySetInnerHTML` prop to an element. Andoracle never does, so these code paths are dead weight from the app's perspective and cannot be reached with user input.
- **Strict CSP is enforced.** `manifest.json` sets:
  `"extension_pages": "script-src 'self'; object-src 'none'; worker-src 'self'"`.
  No inline scripts, no remote script sources, no objects. This blocks the primary attack vectors (inline/remote script injection) that an unsanitized innerHTML would otherwise enable.

## Conclusion

The warnings are a static-analysis false positive triggered by React DOM's bundled internals. There is no dynamic, user-controlled value assigned to `innerHTML` anywhere in this add-on. We request these be treated as non-blocking for review.

---

## How to use this note

1. In the AMO submission flow, when you reach the **Review notes** / "Notes for reviewers" field (or reply to a reviewer's question), paste the **"Summary for reviewers"** and **"Why this is safe"** sections above.
2. If a reviewer asks for proof that no app code uses innerHTML, point them at `src/` — there are no matches for `innerHTML`, `insertAdjacentHTML`, `outerHTML`, or `dangerouslySetInnerHTML`.

## Why we did not "fix" this in code

- Adding a sanitizer (e.g. DOMPurify) would be pointless: there is no application-level `dangerouslySetInnerHTML` to sanitize.
- Pinning a different React version or mangling the minifier output to hide the pattern is fragile and can regress on the next dependency update, so it was intentionally not done.

## If this recurs after a rebuild

The bundle filename (e.g. `index-BlrAGk_W.js`) changes with each build, but the two React-internal `innerHTML` assignments will remain at equivalent locations in the new bundle. This note applies to any future version of the same warning; just update the file/column references if you want them exact.

---

## Appendix: Safe DOM manipulation — why Andoracle does not need innerHTML

For reviewer context, this documents that we are aware of the safe alternatives to assigning an HTML string to `innerHTML`, and that Andoracle deliberately uses the safest one. The unsafe pattern is specifically **assigning a dynamic string of HTML to `.innerHTML`**. Every method below avoids it:

| Method | What it does | Safety |
|---|---|---|
| React text children (`{name}`, `<option>{x}</option>`) | Escapes content automatically at render time | Safe — **this is what Andoracle uses for all user-generated content** (patch names, sequence names, MIDI device names) |
| `document.createElement` + `appendChild` / `append` | Build and insert node objects; no HTML string parsing | Safe |
| `element.textContent = x` | Set plain text only; never parses HTML | Safe |
| `insertAdjacentElement` | Insert a node object, not an HTML string | Safe |
| DOMPurify + `dangerouslySetInnerHTML` | Sanitize the string before insertion | Safe, but only needed if raw HTML *must* be inserted — Andoracle does not do this |

Andoracle renders all dynamic content through React text children, so no user-controlled value is ever passed to an HTML-string setter. The two flagged `innerHTML = t` statements are therefore unreachable in this add-on: they belong to React's internal `dangerouslySetInnerHTML` prop handler and only execute if the application passes that prop, which it never does.

This appendix exists so reviewers can see we understand the safe alternatives and chose them intentionally; it is not a request to change code.
