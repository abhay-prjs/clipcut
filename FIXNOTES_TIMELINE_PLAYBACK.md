# ClipCut — Timeline & Playback Fix Notes

> Audit v2 · 2026-07-26 · Scope: playback stutter, timeline unresponsiveness, timeline visual
> "overlay soup", caption-track overlap, plus the full verified bug list with file:line targets.
> **No code has been changed — this is the spec to implement from.**

---

## 0. Executive summary

| Area | Verdict |
|---|---|
| Cutting engine (segments / playSegments / apply-cuts math) | Solid. Keep. |
| Playback smoothness | Inherent limit of `video.currentTime` jumping. Tune now, add a **preview proxy render** as the real fix. |
| Timeline responsiveness | Caused by full-DOM rebuilds + unvirtualized ruler + per-element listeners. Fixable without a framework. |
| Timeline visuals | 4 translucent systems stacked on each other + a live bug that leaves ghost cut markers after Apply Cuts. Needs the "solid blocks + lanes" redesign in Part C. |
| Caption track | Word-chunk blocks overlap by design at low zoom (forced 30px min-width). Needs zoom-aware collapsing. |

Recommended order of attack is at the bottom (§ Part E).

---

## PART A — PLAYBACK

### A1. Why it stutters (current architecture)

`js/playback/playback.js` drives everything through one `<video>` element:

1. rVFC loop (`_onVideoFrame`) checks `metadata.mediaTime` against `S.playSegments`.
2. At a segment boundary it does `video.currentTime = next.start`.

Every one of those assignments is a **real seek**: the browser flushes the decoder,
seeks the demuxer to the nearest keyframe *before* the target, decodes forward to the
exact frame, then resumes. That's typically 30–250 ms of frozen frame + audio gap,
per boundary. With auto-cut output (often 20–60 small cuts in a talking-head video)
playback becomes machine-gun stutter. **No amount of threshold tuning removes the
seek cost — it's the architecture.**

Secondary stutter sources in the current loop:

- **Seek storms**: after `video.currentTime = X`, one or two more rVFC callbacks can
  fire with the *old* mediaTime before `video.seeking` flips true. The guard at
  `playback.js:93` (`if(video.seeking) return`) helps but doesn't cover the frames
  *between* the assignment and `seeking` becoming true → occasional double-seek to
  the same boundary. Fix: set a `_seekTarget` variable when assigning `currentTime`,
  and ignore rVFC frames until `mediaTime` is within ~0.03s of it.
- **Boundary threshold asymmetry**: jump fires at `t >= curSeg.end - 0.05`
  (`playback.js:119`). At 24fps a frame is 0.042s, so the last frame of a segment is
  sometimes skipped, sometimes not, depending on frame phase → perceived
  inconsistency at cut points. Fix: make the threshold `max(0.05, 1/fps)` using the
  real fps (see bug #12 — fps is obtainable from
  `metadata.presentedFrames`/`mediaTime` deltas or ffprobe at import).
- **`skipTime()` ignores segments** (`playback.js:62`): arrow-key seeking can land
  inside a removed cut, then the loop immediately re-seeks out → visible double-jump.
  Fix: clamp the target through `S.playSegments` (snap to next segment start).

### A2. Options researched (ranked by effort → payoff)

**Option 1 — Tune the current loop (hours).**
The three fixes above (+ the ones in Part D). Reduces stutter *frequency*, cannot
remove the per-boundary seek gap. Do this regardless.

**Option 2 — Double-buffered `<video>` swap (1–2 days). Recommended interim.**
The classic trick used by browser-based clip editors before WebCodecs:

- Two `<video>` elements, same HTTP source URL, stacked in the preview box.
- While segment N plays on video A, video B is already seeked (paused) to
  segment N+1's start — the seek cost is paid *in advance, off-screen*.
- At the boundary: `B.play()`, flip visibility (or opacity) A↔B, then preload
  segment N+2 into A.
- Result: visually gapless cuts; audio has a near-zero gap (a few ms at the
  element swap, generally inaudible for talking-head content).
- Cost: ~150 lines in playback.js; both elements share the existing
  `/video?path=` streaming endpoint, no backend change. Caption overlay,
  flip transform, and rVFC handlers need to target "the active element"
  instead of the `video` global — mechanical refactor.

**Option 3 — Preview proxy render (2–3 days). Recommended end-state.**
This is what CapCut/desktop editors effectively do (pre-rendered preview):

- After Apply Cuts (or on demand via a "Render Preview" button), run the existing
  export pipeline in the background: nvenc **p1**, 1280×720, CQ 32, audio AAC —
  on the RTX 4070 that's ~8–15× realtime, so a 10-min video renders in well under
  a minute, and only the *kept* segments are encoded.
- Save to a temp file, serve through the same `/video` endpoint, and swap
  `video.src` to the proxy. Playback is now **one continuous file → perfectly
  gapless, scrub-anywhere, zero seek logic needed** (playSegments logic bypassed
  while proxy mode is on).
- Keep a `proxyDirty` flag: any segment/cut change invalidates the proxy and falls
  back to virtual playback until re-rendered. Show a small "PROXY / LIVE" pill in
  the playback bar so the mode is always visible.
- Timestamp mapping: proxy time *is* timeline time, so
  `sourceTimeToTimeline()` / its inverse already provide the mapping for the
  playhead, captions and transcript highlight. The inverse function
  (`timelineToSourceTime`) doesn't exist yet — needs writing (trivial: walk
  segments, same shape as `handleTLClick`'s loop).
- Nearly all the plumbing exists: `_export_video` two-pass path in `serve.py`,
  progress via `evaluate_js`, cancellation flag. This is the single highest-value
  playback investment for a "flawless editing feel".

**Option 4 — MSE (Media Source Extensions) gapless feed. Not recommended.**
Feed remuxed fMP4 fragments of only the kept ranges into a SourceBuffer. True
gapless, no re-encode, but requires server-side segment remuxing (keyframe-aligned
splitting, `ffmpeg -c copy` per segment + init-segment handling), byte-offset
bookkeeping, and codec-string negotiation. Significant complexity for a
single-operator tool; the proxy render achieves the same UX with 10% of the code.

**Option 5 — WebCodecs + canvas/AudioWorklet player. Not recommended (now).**
Full decoder control, frame-accurate, what the newest browser pro-editors use.
It means writing a demuxer bridge (mp4box.js), a frame scheduler, and an audio
clock — weeks of work and a second codebase to maintain. Only revisit if ClipCut
ever needs multi-track compositing preview.

### A3. Playback decision

> **Do Option 1 immediately, Option 3 (proxy) as the real fix, Option 2 only if
> you want gapless *before* Apply Cuts** (proxy covers post-apply; pre-apply
> auditioning with skip-cuts ON still uses the jump loop). If forced to pick one:
> **Option 3**.

---

## PART B — TIMELINE RESPONSIVENESS

### B1. Why it freezes (measured causes, file:line)

1. **Full rebuild on every change** — `renderTimeline()` (`js/timeline/timeline.js:12`)
   wipes and recreates *everything*: all segment divs, all cut overlays (×5 elements
   per cut, see Part C), all caption blocks, the entire ruler. It runs on every
   click-select, every cut toggle, every drag-release. With 60 cuts + 400 caption
   words + a long ruler this is thousands of nodes with inline styles, synchronously.
2. **Unvirtualized ruler** — `buildRuler()` (`timeline.js:230`) loops
   `t += interval/4` over the *entire* duration. A 30-min clip at zoom 200
   (interval=1s) = 7,200 iterations × 2–3 elements each = ~20k DOM nodes,
   appended one-by-one (`r.appendChild(m)` per tick → layout thrash). This alone
   explains "timeline sometimes becomes unresponsive" on longer files/high zoom.
3. **Per-element listeners** — every segment div and cut fill gets its own
   `addEventListener` closure on every rebuild (GC churn + attach cost).
4. **`transition:border-color .15s` on `.tl-clip`** (`clipcut.css:260`) — hundreds of
   animatable elements make hover/selection repaints expensive.
5. **Caption track renders every word chunk** (`timeline.js:202`) with a forced
   `min-width: 30px` — at wordsPerCap=2 a 10-min video is ~1,500 caption blocks.
6. **Waveform redraw posted on every render** (`timeline.js:215`) even when neither
   zoom nor segments changed.

### B2. Targeted fixes (no framework, keeps the no-build stack)

- **F-B1 · Virtualize by scroll window.** Render only elements intersecting
  `[tArea.scrollLeft − margin, scrollLeft + clientWidth + margin]`. Re-render on
  `scroll` through a rAF-throttled handler (pattern already exists —
  `_tlRafPending` at `timeline.js:301`). Applies to ruler ticks, caption blocks,
  and cut markers. This is the single biggest responsiveness win. ~80 lines.
- **F-B2 · Split `renderTimeline()` into layers with dirty flags:**
  `renderRuler` (zoom/duration change only) · `renderSegments` (structural change) ·
  `renderCuts` (S.cuts change) · `renderCaptions` (S.captions/zoom change).
  Selection changes should toggle a class on 2 elements, not rebuild the world —
  today `el.click` at `timeline.js:43` calls full `renderTimeline()` just to move
  the `.selected` outline.
- **F-B3 · DocumentFragment batching** everywhere nodes are appended in loops
  (ruler, cuts, captions): build in a fragment, append once.
- **F-B4 · Event delegation.** ⏸ DEFERRED — the on-timeline cut drag (§C6, done)
  needs `setPointerCapture()` on the actual dragged element, which doesn't fit
  a delegated listener on the container, so cuts stay per-element regardless.
  Segments/captions could still delegate, but F-B1 virtualization (next) will
  already cut the live element count to roughly what's visible on screen,
  which was the actual cost driver this item was chasing — revisit only if
  profiling after F-B1 still shows listener-attach cost.
- **F-B5 · CSS containment.** `contain: layout paint` (or `content`) on
  `.track-row`, `.waveform-row`, `#ruler`; drop the `transition` on `.tl-clip`
  (keep it only on `.tl-clip.selected` if wanted).
- **F-B6 · Skip waveform repost** unless `zoom`, `segments`, or `waveformData`
  actually changed (cache a small signature string, compare before posting
  `draw_tl`).
- **F-B7 · Ruler density clamp.** ✅ VERIFIED NOT NEEDED — checked `buildRuler()`'s
  interval breakpoints (1s/2s/5s/10s sub-tick = interval/4) against the actual
  zoom range (`zoomTL` clamps to [20,200]): minimum sub-tick spacing at zoom=20
  is 25px, and every other breakpoint is ≥20px — always well above the 6px
  floor this item worried about. The real cost for long clips is tick *count*
  (duration/interval), which F-B1 virtualization fixes; a density clamp would
  be dead code for a scenario the current zoom range can't produce.

Expected result: renderTimeline cost drops from O(duration × zoom + cuts + words)
to O(visible window), i.e. constant-time feel regardless of clip length.

---

## PART C — TIMELINE VISUAL REDESIGN ("no more soup")

### C1. Inventory of what currently stacks on the video track

For **one selected cut**, `renderTimeline()` creates **five** translucent elements
(`timeline.js:119–181`): rgba fill + left edge line + right edge line + text label
+ a mirrored rgba fill (+2 more lines) on the waveform row. All of it sits on top
of segment blocks that are themselves a translucent gradient
(`rgba(10,132,255,.2) → .06`, `clipcut.css:260`), over a translucent track
background, with unselected-cut "suggestion" ghosts (α .10 fills) and teal
highlight zones (α .12 + borders) mixed into the same lane. Alpha-over-alpha-over-
alpha is exactly the "overlay soup" you're seeing — **and it's amplified by a real
bug:**

> **BUG (root cause of "poop soup after auto-cut/trim"):** unselected cut markers
> (`timeline.js:185–197`) render **unconditionally at raw source-time coordinates**.
> Selected cuts are correctly gated behind `if(!S.snapped)` (`timeline.js:118`),
> but the unselected branch has no such guard and no source→timeline mapping. After
> `applyCuts()`/`snapGaps()` the timeline compresses, and every remaining suggestion
> ghost is drawn at a now-meaningless position, overlapping segments arbitrarily.
> Same class of bug: selected-cut fills use `cut.start*zoom` directly
> (`timeline.js:120`) instead of `sourceTimeToTimeline(cut.start)*zoom`, so they
> are misplaced whenever *any* trim has shifted `timelineStart ≠ sourceStart`
> (i.e. after trimBefore — before any snap).
> **Fix: map every cut through `sourceTimeToTimeline()`, and skip (or gap-mark)
> cuts whose range returns null.**

### C2. Design spec — solid blocks, fixed colors, separated lanes

Principles: **one element per item · solid fills · fixed per-type colors ·
each concern gets its own lane · nothing overlays the video track except the
playhead.**

**New lane stack (top → bottom) inside `#tracksInner`:**

| Lane | Height | Contents |
|---|---|---|
| Ruler | 20px | ticks + markers (unchanged) |
| **Suggestion strip** *(new)* | 8px | unselected/pending cuts as solid mini-bars |
| Video track | 36px | segment blocks + **selected** cut blocks only |
| Waveform row | 50px | canvas only — **delete all mirror divs** |
| Caption track | 24px | caption blocks (see C4) |

**Fixed color tokens** (add to `:root` in clipcut.css — solid, no rgba in fills):

```css
--tl-seg-fill:    #1B3A5C;  /* segment body — solid, derived from --blue */
--tl-seg-border:  #409CFF;
--tl-seg-text:    #BFDBFE;
--tl-cut-dead:    #E5484D;  /* dead_air / silence */
--tl-cut-filler:  #8E6FF7;
--tl-cut-retake:  #C92A2A;
--tl-cut-weak:    #D9A514;
--tl-highlight:   #2AB8A5;  /* keep-zones */
--tl-gap:         #101013;  /* removed region background */
```

**Element rules:**

- **Segments** — solid `--tl-seg-fill`, 1px `--tl-seg-border`, 6px radius, label
  inside. Kill the gradient. Selected = border → white + inner glow, *no*
  `filter:brightness` (forces repaint of the whole layer).
- **Selected cuts** — ONE solid block per cut on the video track:
  `background: var(--tl-cut-*)`, darker 2px left/right **borders** on the same
  element (replaces the two separate edge-line divs), white label if width > 30px
  else no label (tooltip still there). Delete the label-div, edge-divs and all
  three waveform-mirror divs → cut element count drops 5→1 per cut (also a Part-B
  responsiveness win).
- **Unselected cuts (suggestions)** — move OFF the video track entirely, into the
  8px suggestion strip as solid bars in their type color at 55% *lightness*
  (pre-mixed solid hex, not alpha). Click = select/preview as today. The video
  track stays readable no matter how many detections exist.
- **Highlights** — thin solid `--tl-highlight` bar at the top 4px of the video
  track (like YouTube chapter markers), not a full-height translucent wash.
- **Applied cuts / gaps (pre-snap)** — the empty space between segments gets
  `--tl-gap` with a subtle 45° hatch (repeating-linear-gradient, solid colors),
  so "removed" reads instantly. After snapGaps there are no gaps, and — with the
  C1 bug fixed — no ghosts either.
- **Z-index ladder (document it in CSS):** track bg 0 · gap hatch 1 · segments 2 ·
  highlight bar 3 · selected cuts 4 · labels 5 · marquee 15 · playhead 20.
  All current ad-hoc inline z-indexes (3,4,5,6,7,8) get deleted with the extra divs.

### C3. Selection styling

Replace the inline `outline`/`filter` mutations scattered through
`timeline.js:135–140` and `silence.js:562–564` with two CSS classes
(`.cut-selected`, `.seg-selected`) toggled by one function. Single source of
truth, no leftover inline styles after re-render (today a re-render silently
drops the white outline because it lived inline).

### C4. Caption track overlap fix

Cause: word-level chunks (2 words each) + `min-width:30px` forced at
`timeline.js:207` → at zoom 60 any chunk shorter than 0.5s overlaps its
neighbour; at low zoom the whole track is shingled blocks (your screenshot-level
mess). Targeted fix, zoom-aware:

- **Zoom ≥ ~80 px/s:** render blocks as now but **clamp width to
  `next.start − c.start`** (no min-width) → physically cannot overlap.
- **Zoom below that:** collapse the track to a single continuous strip: one solid
  teal bar spanning transcribed regions (merge adjacent captions with gap < 0.3s).
  Zero text, zero overlap, still shows "where speech is".
- Optional middle mode: sentence-level blocks (group chunks until `.!?` — helper
  `_chunkWordsByPunct` in captions.js already knows how) with ellipsized text.
- Caption blocks must ALSO map through `sourceTimeToTimeline()` — currently
  (`timeline.js:206`) they use raw source time and go stale after snap, same bug
  family as C1.

### C5. Addendum — confirmed from live screenshot (36s clip, ~50 px/s zoom)

A screenshot of the real timeline (single 36.25s segment, no cuts applied) revises
C4 and adds two findings:

1. **Word-chunk caption blocks are unreadable at *any* normal zoom, not just low
   zoom.** At ~50 px/s a 2-word chunk is 0.4–0.6s ≈ 20–30px; the forced 30px
   min-width makes every chip overlap its neighbour → a solid shingled wall of
   ~70 chips for a 36s clip. Revision to C4: **sentence-level blocks are the
   default**; word-level blocks only appear above ~150 px/s; the merged solid
   strip kicks in below ~30 px/s.
2. **Every chip renders a 💬 emoji prefix** (`timeline.js:209`) — repeated ~70×,
   it consumes roughly half of each chip's width and adds pure noise. Delete it;
   the lane label "CAPTIONS" already says what the track is.
3. **Captions are colored RED** — `.tl-clip.caption` (`clipcut.css:263`) uses
   `--red` rgba fills. The design system itself defines teal = captions and
   red = cuts/delete. A transcript track full of red chips reads as "70 errors",
   which is a large share of the perceived mess even before any cut overlays
   exist. Enforce fixed color semantics across the whole timeline:
   **blue = video segments · teal = speech/captions · red = cuts only ·
   orange = trim handles · `--tl-highlight` teal-green = keep zones.**
   (Fold into the C2 token table: `--tl-cap-fill:#0E3F4A; --tl-cap-border:#64D2FF;
   --tl-cap-text:#A8E6FF;` — solid, teal family.)

The video track and waveform lanes look fine in the screenshot — the redesign
effort should be weighted: caption lane first, cut rendering second, segment
styling last.

### C6. Direct on-timeline cut dragging (CapCut-style) — spec

Requested from live use: when a filler/dead-air block sits on the timeline, you
should grab its edge and drag it right there — the precision trim bar stays for
fine work, but the timeline is where trimming should feel native.

**Interaction spec (per cut block, and later per segment):**

- **Grab zones**: left/right 8px of every selected-cut block, `cursor: ew-resize`;
  center of the block = `cursor: grab` and drags the whole cut (move, preserving
  duration). Use Pointer Events with `setPointerCapture` so the drag survives
  leaving the block.
- **Mapping**: px→seconds via `S.zoom`, then through the timeline→source inverse
  mapper (`timelineToSourceTime()` — same function Part A's proxy work needs; a
  cut edge dragged across a removed gap clamps at the gap boundary).
- **Clamping**: edge cannot cross the cut's other edge (min 0.05s), the containing
  segment's bounds, or a neighbouring cut of the same lane.
- **Live preview without re-render**: during the drag, update only the block's
  `left/width` style and the trim-context readout — the exact live-nudge pattern
  that already exists in `trim.js:87–92` (`[data-cut-id]` lookup). No
  `renderTimeline()` until pointerup.
- **On pointerup**: `saveHistory()` → commit `cut.start/end` →
  `buildPlaySegments()` → `renderTimeline()`. Optionally seek the video to the
  dragged edge (CapCut does this — instant audition of the new boundary).
- **Snapping** (the thing that makes it feel professional): while dragging, snap
  within ±6px to — word boundaries from `S.captions` (you already have word-level
  timestamps — snapping cut edges to word edges is a headline feature for
  talking-head editing), other cut edges, segment edges, the playhead, and whole
  seconds. Show a 1px white snap-guide line. **Alt = disable snapping** for free
  drag; Shift = 0.25× fine drag (replaces the current always-on 0.5× factor,
  bug #9).
- **Same mechanics for segments** (Phase 5 "edge-drag trimming"): dragging a
  segment's edge adjusts its `sourceStart/sourceEnd` — i.e. slip-trimming a kept
  region directly, which quietly replaces most uses of Trim Before/After buttons.

**Related bug found while speccing (added as #20):** the existing trim-bar cut
drag never calls `saveHistory()` — releasing a cut-edge drag is **not undoable**
(`trim.js:159` mouseup path). The new drag flow must snapshot on pointerup; fix
the trim-bar path the same way.

---

## PART D — FULL TARGETED BUG LIST

Ordered by severity. ☠ = destroys work / corrupts data · ● = broken feature · ○ = polish.

| # | Sev | Where | Bug | Targeted fix |
|---|-----|-------|-----|--------------|
| 1 | ☠ | ~~`js/ui/ui.js:94`~~ | ✅ FIXED (098dbdb) | Keyboard handler ignores contentEditable — typing in the transcript word editor fires Q/W/H/V/Space → trims, flips, play-toggles while typing ("what" = trimAfter + flips) |
| 2 | ☠ | ~~`js/detection/silence.js:459`~~ | ✅ FIXED (e1e1e04) | `applyCuts()` wiped `S.captions=[]`/`S.chatHistory=[]` unnecessarily — deleted the wipe |
| 3 | ☠ | ~~`js/playback/playback.js:230`~~ | ✅ FIXED (633defd) | `_deduplicateCuts` mutated the real cut objects in `S.cuts` — now copies before merging |
| 4 | ● | ~~`js/timeline/timeline.js:185`~~ | ✅ FIXED (f07b102) | Unselected-cut ghosts rendered at raw source coords with no `!S.snapped` guard and no mapping — now mapped via `sourceTimeToTimeline()` and gated behind `!S.snapped` |
| 5 | ● | ~~`js/timeline/timeline.js:120`, `:206`~~ | ✅ FIXED (f07b102) | Selected cuts & caption blocks positioned by raw `t*zoom` — now mapped via `sourceTimeToTimeline()` |
| 6 | ● | ~~`js/ui/ui.js:106` + everywhere~~ | ✅ FIXED (de41ea6) | No way to delete a segment — added `deleteSegment()`, wired into Delete-key branch when `S.selectedSegmentId` set |
| 7 | ● | ~~`serve.py:1243,1248`~~ | ✅ FIXED (9cfa04a) | Native menu called `deleteSelectedCut()`/`zoomToFit()` — extracted both into named JS functions shared with keydown/dblclick handlers |
| 8 | ● | ~~— (absent)~~ | ✅ FIXED (1fac48a, b76282e) | No project save/load — added `.ccproj` save/open (native dialogs), 30s autosave, startup recovery prompt; wired into topbar + File menu |
| 9 | ● | ~~`js/timeline/trim.js:77`~~ | ✅ FIXED (a20bea4) | Cut-handle drag multiplied delta by 0.5 — removed the factor |
| 10 | ● | ~~`js/captions/captions.js` (styling fns)~~ | ⚠ PARTIALLY FIXED (e2010ff) | Caption styling moved from inline-DOM-only into `S.textStyle` (now undoable, persisted, single source of truth via `_applyTextStyle()`). **Still not passed to export** — burn-in still renders plain SRT text; needs an ASS-generation pass (font/size/color/outline/position → ASS style directives, swap `subtitles=` to consume it) — bigger, separate task tied to Part F4's karaoke captions work |
| 11 | ● | ~~`js/media/export.js:425–450` vs `captions.js:307`~~ | ✅ FIXED (d0f9306) | Two SRT/VTT exporters — the persistent Export footer called the legacy raw-timestamp pair; repointed at `exportCaptions()`, deleted the legacy pair |
| 12 | ○ | ~~`js/captions/captions.js:8`~~ | ✅ FIXED (91eeb7c) | `_captionFps` was hardcoded 30 — now probed via ffprobe at import (`probe_fps()`) and synced on clip select |
| 13 | ○ | ~~`js/timeline/timeline.js:273`~~ | ✅ FIXED (b60436f) | `handleTLClick` in a pre-snap gap resolved to *last* segment's end (assignment inside loop) instead of nearest boundary — now finds surrounding segments and snaps to the nearer edge |
| 14 | ○ | ~~`js/timeline/trim.js:145`~~ | ✅ FIXED (48bd3e9) | Marquee select iterated `S.clips` using `clip.timelineStart` which nothing sets — dead selection logic removed, marquee box + click-suppression kept |
| 15 | ○ | ~~`js/timeline/trim.js:25` + `updateTrimUI`~~ | ✅ FIXED (34616f6) | Trim bar maps by `t/S.duration` (source time) — determined this is correct behavior (trimIn/trimOut bound the whole clip, independent of cuts), took the "explicitly label" option instead of remapping |
| 16 | ○ | ~~`js/playback/playback.js:62`~~ | ✅ FIXED (8d3f169) | `skipTime()` could land inside removed cuts → double-jump — now clamps through playSegments |
| 17 | ○ | ~~`js/media/export.js:171–301` + `whisper.js:7`~~ | ✅ FIXED (a902c7b) | Dead Flask export path deleted (`_doFlaskExport`, SSE, `getWhisperBase`, `exportMP4FFmpeg`, `browseExportFolder`) — `startExport` routes pywebview-only, error toast otherwise |
| 18 | ○ | ~~`js/ui/ui.js:196–197`~~ | ✅ FIXED (5f12cdc) | `toggleCutSkip` called `renderAllFindings()` twice — removed dup |
| 19 | ○ | `CLAUDE.md` | File-structure section says `home_editor/`; files live at repo root — misleads future sessions | Update doc |
| 20 | ● | ~~`js/timeline/trim.js:159`~~ | ✅ FIXED (801713e) | Cut-edge drag (trim bar) committed without `saveHistory()` — now snapshots at mousedown; on-timeline drag (§C6) still needs the same treatment when built |
| 21 | ● | ~~`js/ui/ui.js:39` (`setAspect`) + `serve.py` export~~ | ✅ FIXED (69daaf0) | Aspect ratio was preview-only — `S.aspect`/`S.aspectMode` now real state, `export_video()` applies a crop/pad ffmpeg filter, export modal has a Crop/Pad toggle |
| 22 | ● | ~~`js/core/state.js` + `js/media/import.js:122` (`selectClip`)~~ | ✅ FIXED (dbc8827) | Edit state was global not per-clip — `selectClip()` now persists outgoing clip's cuts/captions/markers/waveformData back onto it, loads incoming clip's own copies |

---

## PART E — IMPLEMENTATION ORDER

**Phase 1 — stop the bleeding (½ day)** ✅ DONE — #1, #2, #3, #7, #9, #14, #16, #18, #20 all fixed and pushed (commits 098dbdb..48bd3e9).
Bugs #1, #3, #18 (one-liners) · #2 (delete one line) · #9 (delete a factor) · #7 (wire menu).

**Phase 2 — timeline correctness + visuals (1–2 days)** ✅ DONE (mostly) — commits b19907c..65f567c.
#4, #5, #13 (mapping) → then the Part C redesign: lane stack, solid color tokens,
1-element cuts, suggestion strip, gap hatching, caption-track clamping (C4).
Do the redesign *after* the mapping fixes so blocks land where they should.
Then §C6 on-timeline cut dragging (edges + move + snapping) — it depends on the
mapping fixes and the 1-element cut blocks, and includes bug #20.

*Landed:* mapping fixes (#4/#5/#13), solid color tokens, suggestion strip lane,
1-element cut blocks, thin highlight bar, waveform-row mirror divs deleted,
`.cut-selected`/CSS-class selection styling, sentence-level caption track with
teal colors, and §C6 on-timeline drag (edges + move + snap-to-word/cut/segment/
playhead/whole-second, Alt=no-snap, Shift=fine-drag).
*Deferred (flagged, not silently dropped):*
- **Gap hatching** — needs a real gap in segment `timelineStart` layout pre-snap;
  `applyCuts()`/`snapGaps()` currently always lay segments out contiguously, so
  there's nothing to hatch today. Would require changing segment/timeline
  semantics (touches `applyCuts`, `snapGaps`, `sourceTimeToTimeline`,
  `buildPlaySegments`) — bigger than a rendering change, do as its own task.
- **§C6 full clamping** — drag currently only enforces the 0.05s min-gap between
  a cut's own start/end; clamping to the containing segment's bounds and to
  neighbouring same-lane cuts isn't implemented (snapping covers the common
  case, but a fast drag can still push a cut out of its segment or across a
  neighbour).

**Phase 3 — timeline performance (1 day)** ✅ DONE (mostly) — commits 60f18cd..adbb36f.
F-B1 virtualization → F-B2 layer split → F-B3/B4 batching + delegation → F-B5/B6 CSS/waveform.
(Phase 2 already cut per-cut DOM cost 5×, so measure after it — you may only need F-B1/B2.)

*Landed:* F-B5 (CSS containment), F-B6 (skip redundant waveform redraw), F-B3
(DocumentFragment batching in ruler/cuts/captions), ruler tick virtualization
by scroll window (the single biggest DOM-node source), segment-click selection
no longer triggers a full `renderTimeline()` rebuild.
*Verified not needed:* F-B7 (ruler ticks already ≥20px apart at every current
zoom breakpoint — no scenario to clamp).
*Deferred:*
- **F-B4 event delegation** — conflicts with §C6's `setPointerCapture()` drag
  on individual cut elements; revisit only if profiling after virtualization
  still shows listener-attach cost.
- **Cut/caption block virtualization + the full 4-way renderRuler/
  renderSegments/renderCuts/renderCaptions dirty-flag split** — cut/caption
  counts are already far smaller post-Part-C (1 element/cut, sentence-level
  captions), so payoff shrank; the risk of a virtualization bug (elements
  losing click/drag bindings as they pop in/out) needs real interactive
  testing, not a blind pass — do as its own dedicated task if a long clip is
  still measurably slow after everything above.

**Phase 4 — playback (tuning: hours · proxy: 2–3 days)** — tuning ✅ DONE (commits f819559, 91eeb7c); proxy render not started.
A2-Option-1 tuning fixes, then the **preview proxy render** (Option 3). Add
`timelineToSourceTime()` inverse mapper as part of this (already added in
Phase 2's §C6 work, commit 0cef490).

*Landed:* seek-storm guard (`_seekTarget`/`_jumpTo`), fps-aware segment
boundary threshold (`max(0.05, 1/fps)`), real fps probing via ffprobe at
import (also fixes bug #12). `skipTime()` clamping (bug #16) and the trim-bar
undo fix (bug #20) were already done in earlier phases.
*Not started:* the preview proxy render itself — a genuinely separate,
larger feature (background nvenc render, `proxyDirty` state, PROXY/LIVE UI
pill, bypass-playSegments-while-proxy-active logic). Worth scoping as its
own task rather than folding into this pass.

**Phase 5 — durability & headline features** ✅ bugs #6/#8/#10(partial)/#21/#22 DONE — commits de41ea6..d5b79b5.
#8 project save/autosave → #10 text-style state → templates → drag-in-preview →
ASS burn-in → #6-adjacent editor feel: frame-step keys (←/→ = 1 frame), segment
edge-drag trimming, snap-to-word-boundary while dragging cuts.
*Not started:* templates, drag-in-preview, ASS burn-in (needs #10's remaining
half), frame-step keys, segment edge-drag trimming.

**Phase 6 — cleanup** ✅ DONE — commits d0f9306..34616f6 (plus #12/#14/#16 done earlier in Phases 1/4).
#11, #12, #14, #15, #16, #17, #19 — all 7 done.

## ALL 22 BUGS ADDRESSED
20 fully fixed, 2 partial with documented follow-ups (gap hatching in Part C
needs a segment-model change; caption export styling needs an ASS pipeline).
Phases 1-6 complete. Remaining scope is Phase 7 (Part F product roadmap) and
the two explicitly-deferred larger items: the preview-proxy render (Phase 4)
and full timeline virtualization for cuts/captions (Phase 3).

**Session note — two pre-existing issues observed (not in fix notes, not fixed this pass):**
1. ✅ FIXED (later session) — `webview.MenuAction`/`webview.MenuSeparator` raised
   `AttributeError` not because native menus are unsupported, but because
   pywebview 5+ moved them into the `webview.menu` submodule and stopped
   re-exporting them at top level. `serve.py` now does
   `from webview.menu import Menu, MenuAction, MenuSeparator` — the native
   menu (File/Edit/View/Help, including the Save/Open Project entries from
   bug #8) actually appears now on pywebview 6.1.
2. ✅ FIXED (later session) — `serve.py` now reconfigures `sys.stdout`/`sys.stderr`
   to UTF-8 with `errors='replace'` at startup, and `log()` has an ASCII-fallback
   `except UnicodeEncodeError` as a last resort — a stray ✓/✕ under cp1252 no
   longer crashes the thread that logged it.

---

## PART F — PRODUCT ROADMAP: "CapCut for UGC, automated"

Direction: not a general editor — a **UGC factory**. Import raw talking-head
footage → auto-cut → captions → template → (batch) export, with manual editing
that feels as direct as CapCut when you need to intervene. Everything below is
spec'd against what CapCut actually does, adapted to ClipCut's no-build stack.

### F1. Universal trim grammar (one interaction, every object)

§C6's drag mechanics must not be a cut-only feature. Define **one** drag helper
and register every timeline object through it:

```
makeTrimmable(el, {
  getRange(),            // current {start, end} in timeline seconds
  bounds(),              // clamp range {min, max} + neighbour edges
  snapTargets(),         // word edges, cut edges, segment edges, playhead, whole seconds
  onPreview(start,end),  // live style nudge only — no renderTimeline
  onCommit(start,end),   // saveHistory → mutate state → buildPlaySegments → render
})
```

| Object | Edge drag | Center drag | Extras |
|---|---|---|---|
| Cut block | resize cut | move cut (keep duration) | seek-on-release audition |
| Segment | slip trim (`sourceStart/End`) | — (v1) | optional **ripple mode** toggle: downstream segments shift live to close the gap (CapCut's default feel) |
| Caption block | retime caption | move caption | double-click = edit text (exists) |
| Text layer (future) | retime | move in time | drag in *preview box* moves in space (§audit v1) |
| Music/B-roll (future) | trim | move | same grammar, zero new learning |

Shared modifiers everywhere: **snap ±6px with guide line · Alt = no snap ·
Shift = 0.25× fine · always one `saveHistory()` per gesture** (fixes #20 by
construction). The precision trim bar stays as an inspector, no longer the
primary tool.

### F2. Edit verification — local lint + AI cross-check ("feels off" detector)

Research note: most "something feels off" moments after auto-cutting are
**mechanically detectable** — you don't need an LLM for the first tier, and the
data (word timestamps, RMS frames) is already in memory.

**Tier 1 — deterministic edit linter — ✅ IMPLEMENTED (`js/detection/linter.js`,
"🔍 Check Edit" button in the Silence tab). Built pre-apply against currently
*selected* cuts rather than post-apply against committed segments — once
`applyCuts()` runs, cuts no longer exist as objects to snap/merge, so
reviewing right before Apply is both simpler and more actionable:**

| Check | Signal | Auto-fix offer |
|---|---|---|
| Mid-word cut | cut edge falls inside `[word.start, word.end]` of any caption | snap edge to nearest word boundary |
| Audio-pop risk | cut edge lands on RMS frame above threshold (waveform frames exist at 0.05s resolution) | snap edge to nearest RMS valley within ±0.15s — this is what pro auto-editors do to avoid clicks |
| Orphan sliver | kept gap < 0.5s between two selected cuts | merge via existing `mergeCuts()` |
| Machine-gun pacing | > 6 selected-cut starts per 10s window | merge via existing `mergeCuts()` with a looser threshold |
| Sentence amputation | cut removes > 60% of a sentence (local lightweight punct-grouping in linter.js) | flag for review only — no safe auto-fix for a content judgment call |
| Dead start/end | leading/trailing silence not covered by any selected cut | adds a new `dead_air` cut spanning it |

Renders as a review list reusing the `.sil-result-item` findings-card style;
each row = jump (click) + optional one-click Fix button. Not yet done:
Tier 2 (LLM cross-verification) — tracked separately.

**Tier 2 — LLM cross-verification (uses existing OpenRouter/Ollama + ACTION
plumbing):** send the *planned edit* — segment durations, cut list with
types/reasons, transcript with on-script/ad-lib marks (LCS diff already
implemented) — and ask for review only: pacing verdict, hook check (is the first
3s strong?), cuts that change meaning, retakes where the *wrong* take was kept.
Responses come back as the existing ACTION blocks in **review mode** (approve/
reject per suggestion — this is literally the pending "cut review mode" feature;
wire it here). Gate behind Deep mode; Tier 1 always runs.

### F3. Batch export + template selection

The automated-factory core. CapCut has batch only in its commercial tooling —
this is where ClipCut can be *better* for UGC.

- **Job model**: each imported clip already owns `clip.segments`; add
  `clip.cuts`, `clip.captions`, `clip.templateId` so per-clip edit state fully
  swaps on `selectClip` (today captions/cuts are global-only — prerequisite,
  note it). An export job = `{sourcePath, segments, captions, template,
  preset, outName}`.
- **Queue UI**: export modal gains a "Batch" tab — list of clips with
  checkbox · template dropdown · status column (queued/encoding %/done/failed).
  Naming pattern with tokens: `{name}_{template}_{date}`. Continue-on-failure,
  per-job cancel.
- **Backend**: `export_batch(jobs_json)` in serve.py — sequential loop over the
  existing `_export_video` internals (nvenc serializes anyway), one native SAVE
  → *folder* picker for the batch, progress via the existing `evaluate_js`
  channel with a job index. Mostly plumbing, no new encode logic.
- **Factory pipeline** (the headline): "Process All" button = for each clip:
  Auto Mode (exists, per-clip) → Tier-1 lint auto-fixes → apply template →
  enqueue export. Drop 10 raws, return to 10 finished verticals.

### F4. Templates — expanded to full UGC presets

Upgrade the audit-v1 template (caption style JSON) into a **UGC preset**:

```json
{ "name": "TikTok Hook v2",
  "aspect": "9:16",
  "textLayers": [ {"slot":"hook","anchor":"top-safe","style":{...}},
                  {"slot":"captions","anchor":"lower-third","style":{...}} ],
  "captionMode": "word-highlight",
  "exportPreset": "balanced",
  "autoSettings": { "useVAD": true, "autoFillers": true }
}
```

- **Platform safe zones** (research: fixed rects where TikTok/Reels/Shorts UI
  covers video — roughly top 10%, bottom 18–20%, right 12% on 9:16): anchors
  place text *inside* safe area automatically; show safe-zone guides as an
  overlay toggle in the preview box.
- **Word-highlight captions (the CapCut signature look)**: achievable free via
  **ASS karaoke timing** — Whisper word timestamps → `\k` tags per word →
  libass renders the bouncing per-word highlight in the existing
  `subtitles=` burn-in path, GPU pipeline unchanged. This single feature closes
  most of the visual gap to CapCut's caption templates. Preview side: the
  existing overlay div highlights the active word (transcript highlighter logic
  already tracks it).
- Templates stored in `templates.json` next to config; "Save current as
  template" from the inspector; template picker in Apply-stage and Batch tab.

### F5. CapCut-parity checklist (UGC-relevant only)

| CapCut feature | ClipCut status | Verdict |
|---|---|---|
| Auto captions, word-level | ✅ have (Whisper/WhisperX, better accuracy) | keep |
| Animated caption styles / word highlight | ⚠ static only | **F4 ASS karaoke — do** |
| Silence / filler auto-cut | ✅ have (VAD + ffmpeg + fillers, arguably better) | keep |
| Direct block trimming on timeline | ✕ | **F1 — do** |
| Ripple editing | ✕ (snapGaps is manual) | F1 ripple toggle |
| Templates | ✕ | **F4 — do** |
| Batch/auto pipeline | ⚠ single-clip Auto Mode | **F3 — do** |
| Aspect presets + safe zones | ⚠ aspect only, preview-only | F4 safe zones + export-side crop/pad (ffmpeg scale/pad per aspect — export currently ignores aspect entirely; flag as gap) |
| Music + auto-ducking | ✕ | later (P3) — sidechaincompress filter, one track |
| Speed ramp / curves | ✕ | later (P3), UGC value is modest |
| Background removal, effects, stickers | ✕ | **out of scope — don't chase** |
| Multi-track compositing | ✕ | out of scope; text layers cover UGC needs |

Two genuine gaps surfaced by this comparison, now filed with targeted fixes in
the Part D table: **export ignores the chosen aspect ratio** (bug **#21** —
ffmpeg crop/pad stage) and **per-clip edit state** (bug **#22** — persist
cuts/captions/waveform onto the clip object on `selectClip` swap; prerequisite
for F3 batch).

### F6. Revised phase plan (supersedes Part E ordering from Phase 5 on)

1. Phase 1–4 unchanged (bug fixes → timeline redesign+C6 → perf → playback proxy).
2. **Phase 5 — Universal trim (F1)** + Tier-1 edit linter (F2) — makes manual
   correction fast and auto output trustworthy.
3. **Phase 6 — State groundwork**: per-clip edit state, text-layer state,
   project save/autosave (#8, #10).
4. **Phase 7 — Templates (F4)**: presets, safe zones, ASS karaoke burn-in,
   export-side aspect handling.
5. **Phase 8 — Batch (F3)**: queue backend + Batch tab + factory "Process All".
6. **Phase 9 — Tier-2 AI review (F2)** wiring through ACTION review mode.

---

*Everything above was verified against the working tree at commit `0fef7d5`
(files at repo root). Line numbers drift as edits land — search the quoted
identifiers if a number is stale.*
