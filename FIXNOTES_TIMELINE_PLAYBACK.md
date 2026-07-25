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
- **F-B4 · Event delegation.** One `click` listener on `#videoTrack` and one on
  `#captionTrack`; resolve the target via `e.target.closest('[data-seg-id],[data-cut-id]')`.
  Removes thousands of listener attachments per rebuild.
- **F-B5 · CSS containment.** `contain: layout paint` (or `content`) on
  `.track-row`, `.waveform-row`, `#ruler`; drop the `transition` on `.tl-clip`
  (keep it only on `.tl-clip.selected` if wanted).
- **F-B6 · Skip waveform repost** unless `zoom`, `segments`, or `waveformData`
  actually changed (cache a small signature string, compare before posting
  `draw_tl`).
- **F-B7 · Ruler density clamp.** Even virtualized, cap sub-tick density so ticks
  are never < 6px apart; below that draw major ticks only. (Optional: draw the
  ruler into a canvas strip — it's non-interactive, cheapest possible win — but
  virtualization alone is sufficient.)

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

---

## PART D — FULL TARGETED BUG LIST

Ordered by severity. ☠ = destroys work / corrupts data · ● = broken feature · ○ = polish.

| # | Sev | Where | Bug | Targeted fix |
|---|-----|-------|-----|--------------|
| 1 | ☠ | `js/ui/ui.js:94` | Keyboard handler ignores contentEditable — typing in the transcript word editor fires Q/W/H/V/Space → trims, flips, play-toggles while typing ("what" = trimAfter + flips) | Add `e.target.isContentEditable` to the early-return guard |
| 2 | ☠ | `js/detection/silence.js:459` | `applyCuts()` wipes `S.captions=[]`. Captions store source timestamps; overlay & `exportCaptions()` already remap through segments — the wipe forces a full re-transcribe after every apply for no reason | Delete the wipe (and the `S.chatHistory=[]` wipe if chat context rebuilds from captions). Keep captions; they remain valid |
| 3 | ☠ | `js/playback/playback.js:230` | `_deduplicateCuts` mutates the real cut objects in `S.cuts` (`prev.end = Math.max(...)`) — every `buildPlaySegments()` can permanently widen detected cuts | Copy before merging: `const out=[{...sorted[0]}]` and push `{...cur}` |
| 4 | ● | `js/timeline/timeline.js:185` | Unselected-cut ghosts render at raw source coords with no `!S.snapped` guard and no mapping — the post-apply "soup" (see Part C1) | Map via `sourceTimeToTimeline()`, skip nulls |
| 5 | ● | `js/timeline/timeline.js:120`, `:206` | Selected cuts & caption blocks positioned by raw `t*zoom` — wrong after any trim shifts timelineStart | Same mapping fix as #4 |
| 6 | ● | `js/ui/ui.js:106` + everywhere | **No way to delete a segment.** Split (Ctrl+B) exists, but Delete handles cuts/findings/clips only — the universal "split → delete bad half" flow is impossible | Add `deleteSegment()`: remove from `S.segments`, recompute `timelineStart` chain, `saveHistory` → `buildPlaySegments` → `sliceWaveforms` → `renderTimeline`; wire into Delete-key branch when `S.selectedSegmentId` set |
| 7 | ● | `serve.py:1243,1248` | Native menu calls `deleteSelectedCut()` / `zoomToFit()` — neither exists in JS → menu items throw | Implement both (zoomToFit logic already exists in the dblclick handler `timeline.js:344`) or point menu at existing fns |
| 8 | ● | — (absent) | **No project save/load.** Everything (cuts, captions, segments, styles) dies with the window. CLAUDE.md even documents a "Save Project" menu that doesn't exist | Serialize the same object `_makeSnapshot()` already builds + sourcePaths → JSON via pywebview save/open dialogs; add 30s autosave to a temp file + startup recovery prompt |
| 9 | ● | `js/timeline/trim.js:77` | Cut-handle drag multiplies delta by 0.5 — handle moves half the mouse distance, feels broken | Remove the factor; if fine-drag wanted, make Shift = 0.25× |
| 10 | ● | `js/captions/captions.js` (styling fns) | All caption styling is inline DOM styles on `#captionOverlay` — not in `S`, not in undo, not persisted, **not passed to export** → burned-in output ignores everything you styled | Introduce `S.textStyle` / `S.textLayers[]` as source of truth (prereq for templates & drag-in-preview; see previous audit) — then generate an **ASS** file from it for burn-in (`subtitles=` filter renders ASS natively; carries font/size/color/outline/position) |
| 11 | ● | `js/media/export.js:425–450` vs `captions.js:307` | Two SRT/VTT exporters: `exportCaptions()` (correct, cut-remapped) and legacy `exportSRT()/exportVTT()` (raw timestamps). Whichever the UI wires, one produces drifted subs after cuts | Delete the legacy pair; alias names to `exportCaptions('srt'/'vtt')` |
| 12 | ○ | `js/captions/captions.js:8` | `_captionFps` hardcoded 30 — frame-snapping wrong for 24/25/60fps footage | Probe real fps at import (ffprobe already used for duration) and store on the clip |
| 13 | ○ | `js/timeline/timeline.js:273` | `handleTLClick` in a pre-snap gap resolves to *last* segment's end (assignment inside loop) instead of nearest boundary | Compute nearest boundary of the gap |
| 14 | ○ | `js/timeline/trim.js:145` | Marquee select iterates `S.clips` using `clip.timelineStart` which nothing sets — dead multi-clip remnant | Delete, or repoint at `S.segments` |
| 15 | ○ | `js/timeline/trim.js:25` + `updateTrimUI` | Trim bar and its playhead map by `t/S.duration` — visually wrong after cuts/snap | Map through playSegments, or explicitly label the bar "source" |
| 16 | ○ | `js/playback/playback.js:62` | `skipTime()` can land inside removed cuts → double-jump | Clamp through playSegments |
| 17 | ○ | `js/media/export.js:171–301` + `whisper.js:7` | Entire Flask export path (`_doFlaskExport`, SSE, `getWhisperBase`) is dead per your own architecture (Flask removed) — ~200 lines of confusion | Delete; `startExport` routes pywebview-only, error toast otherwise |
| 18 | ○ | `js/ui/ui.js:196–197` | `toggleCutSkip` calls `renderAllFindings()` twice | Remove dup |
| 19 | ○ | `CLAUDE.md` | File-structure section says `home_editor/`; files live at repo root — misleads future sessions | Update doc |

---

## PART E — IMPLEMENTATION ORDER

**Phase 1 — stop the bleeding (½ day)**
Bugs #1, #3, #18 (one-liners) · #2 (delete one line) · #9 (delete a factor) · #7 (wire menu).

**Phase 2 — timeline correctness + visuals (1–2 days)**
#4, #5, #13 (mapping) → then the Part C redesign: lane stack, solid color tokens,
1-element cuts, suggestion strip, gap hatching, caption-track clamping (C4).
Do the redesign *after* the mapping fixes so blocks land where they should.

**Phase 3 — timeline performance (1 day)**
F-B1 virtualization → F-B2 layer split → F-B3/B4 batching + delegation → F-B5/B6 CSS/waveform.
(Phase 2 already cut per-cut DOM cost 5×, so measure after it — you may only need F-B1/B2.)

**Phase 4 — playback (tuning: hours · proxy: 2–3 days)**
A2-Option-1 tuning fixes, then the **preview proxy render** (Option 3). Add
`timelineToSourceTime()` inverse mapper as part of this.

**Phase 5 — durability & headline features**
#8 project save/autosave → #10 text-style state → templates → drag-in-preview →
ASS burn-in → #6-adjacent editor feel: frame-step keys (←/→ = 1 frame), segment
edge-drag trimming, snap-to-word-boundary while dragging cuts.

**Phase 6 — cleanup**
#11, #12, #14, #15, #16, #17, #19.

---

*Everything above was verified against the working tree at commit `0fef7d5`
(files at repo root). Line numbers drift as edits land — search the quoted
identifiers if a number is stale.*
