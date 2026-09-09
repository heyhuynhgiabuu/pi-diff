# @heyhuynhgiabuu/pi-diff v0.9.0

## Added

- Structured multi-edit `apply_patch` updates with overlap rejection.
- Adversarial coverage for workspace boundaries, symlinks, encoding, line endings, modes, concurrency, moves, deletes, and previews.

## Changed

- Confine `apply_patch` paths to Pi's current workspace and reject ancestor symlink traversal.
- Prepare all changes before committing, serialize overlapping operations, preserve file metadata, and report best-effort rollback failures.
- Validate action-specific structured input at both the tool schema and runtime boundary.
- Generate structured diffs and render previews for previewable changes in mixed batches.

## Fixed

- Reject ambiguous or overlapping source matches, invalid UTF-8 files, and add/move collisions instead of silently rewriting or clobbering files.

## Install

```bash
pi install npm:@heyhuynhgiabuu/pi-diff@0.9.0
```
