# @heyhuynhgiabuu/pi-diff v0.9.1

## Added

- Tolerant `apply_patch` input: JSON-string payloads, a single change object, and `edits` sent as a JSON string or a single object.

## Changed

- `apply_patch` matching is exact first, then tolerates escaped sequences and Unicode/trailing-whitespace drift; a fuzzy match is accepted only when it is unique, and non-uniform indentation is refused instead of guessed.
- `write`, `edit`, and `apply_patch` bodies sit directly under the tool title, with no title/body gap.
- The `apply_patch` header resolves the theme's tool background before painting.

## Fixed

- Ambiguous `apply_patch` matches now report how many times `oldText` matched and ask for more context, instead of a misleading "not found".

## Install

```bash
pi install npm:@heyhuynhgiabuu/pi-diff@0.9.1
```
