# ClipCut — Session Progress (2026-07-26)

> Working through `FIXNOTES_TIMELINE_PLAYBACK.md` end-to-end, one item at a
> time. This doc is a plain-language summary of what shipped; the fix notes
> doc itself has the full technical detail and file:line references, now
> struck through / marked done per item.

**Status: all 22 bugs from the fix notes are addressed** (20 fully, 2 partial
with follow-ups flagged below). Every change is its own commit on `master`,
pushed as it landed. Commit range: `098dbdb..b66c781`.

---

## Phase 1 — quick bug fixes
9 small fixes, each one line to a dozen:
- Keyboard shortcuts no longer fire while typing in the transcript editor
- `applyCuts()` no longer wipes captions/chat history unnecessarily
- Fixed a bug where merging overlapping cuts permanently widened them
- Cut-handle drag now tracks the mouse 1:1 (was moving at half speed)
- Removed a duplicate render call
- Native menu's "Delete Selected Cut" / "Zoom to Fit" actually work now (didn't exist in JS before)
- Cut-edge drag (trim bar) is now undoable
- Arrow-key seeking can no longer land inside a removed cut
- Deleted dead marquee-select code that never actually selected anything

## Phase 2 — timeline correctness + visual redesign
- Fixed cut/caption blocks rendering in the wrong place after any trim (mapping bug)
- Fixed clicking in a gap resolving to the wrong position
- **Full visual redesign**: cuts went from 5 stacked DOM elements to 1 solid
  block; unselected/pending cuts moved to their own "suggestion strip" lane
  instead of overlaying the video track; highlights are now a thin top bar
  instead of a full-height wash; captions switched from word-chunks (which
  overlapped at every normal zoom) to sentence-level grouping, lost the 💬
  emoji noise, and changed color from red to teal (matching the app's own
  color semantics — red means "cut," not "captions")
- **New feature**: drag cut edges/centers directly on the timeline (grab to
  resize or move), with snapping to word boundaries, other cuts, segment
  edges, the playhead, and whole seconds

## Phase 3 — timeline performance
- CSS containment so hover/selection repaints don't cost the whole timeline
- Skip re-drawing the waveform when nothing that affects it changed
- Batched DOM insertions (was one-at-a-time, now built in a fragment first)
- Virtualized the ruler so it only builds ticks for what's on screen (was
  building thousands of tick elements for the entire clip duration on every render)
- Selecting a segment no longer triggers a full timeline rebuild

## Phase 4 — playback tuning
- Fixed a stutter-causing bug where the playback loop could double-jump at
  a cut boundary
- Segment-boundary detection is now tuned to the video's real frame rate
  (was a fixed threshold that didn't match 24/25/60fps footage evenly)
- Real fps is now probed via ffprobe at import instead of assumed to be 30

## Phase 5 — bigger fixes
- **Delete a segment** — there was no way to remove a segment after
  splitting it; now there is
- **Per-clip state** — switching between imported clips no longer loses or
  mixes up cuts/captions/markers from the previous clip
- **Aspect ratio actually affects export** — picking 9:16 in the preview
  used to be cosmetic only; now it crops or pads the exported video to match
- **Caption styling moved into real app state** — font/size/color/stroke/position
  are now undoable and persist, instead of living only as invisible-to-the-app
  inline styles (exporting burned-in captions with your chosen style is a
  separate follow-up — noted below)
- **Project save/load** — save and reopen a `.ccproj` file (all your clips,
  cuts, captions, markers), plus autosave every 30s and a recovery prompt if
  the app didn't close cleanly

## Phase 6 — cleanup
- Deleted two competing caption exporters, keeping the one that's actually correct after cuts
- Deleted ~200 lines of dead code left over from before Flask was removed
- Labeled the trim bar clearly as showing source time (it was correct, just confusing)
- Fixed a stale reference in CLAUDE.md to a folder structure that no longer exists

---

## What's explicitly NOT done (flagged, not silently skipped)

- **Gap hatching** (showing removed cut regions as visibly blank/hatched
  space) — would require changing how segments lay out internally; bigger
  than a rendering tweak, scoped as its own task
- **Caption styles in exported video** — the style state now exists, but
  export still burns in plain text; making the exported video match your
  chosen font/color/etc needs an ASS-subtitle pipeline (separate task)
- **Preview-proxy render** (background re-encode for perfectly gapless
  scrub-anywhere playback) — a genuinely separate multi-day feature, not a bug fix
- **Full cut/caption virtualization** — the DOM cost dropped a lot from the
  redesign already; only the ruler got scroll-based virtualization this pass
- **Two pre-existing issues noticed** (not caused by this session, not
  fixed): the installed pywebview build doesn't support native menus, and
  the terminal logger crashes on ✓/✕ characters under Windows' default
  console encoding

## What's next
Part F of the fix notes has a longer product roadmap (batch export,
templates, an automated edit linter, AI review) — untouched this session.
Recommend running the app and clicking through the redesigned timeline,
cut dragging, and project save/load before deciding what's next.
