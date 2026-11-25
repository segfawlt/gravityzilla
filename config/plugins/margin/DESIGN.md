# Margin Overview — Design System Contract

## Visual Direction

Quiet monochrome Antigravity Hub side-pane aligned with the native `swarm_board` surface and Google's Material / DeepMind ink hierarchy. Color communicates status (`--ok`, `--warn`, `--bad`, `--accent` on active progress/focus), never decorative chrome, card borders, shadows at rest, or eyebrow badges.

## Typography

- **Primary UI Font:** `'Google Sans Flex', var(--font-family, var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif))`
  - Body text (`body`): `13px`, line-height `1.48`, `font-variant-numeric: tabular-nums`, `font-variant-ligatures: no-contextual`, `font-variation-settings: "ROND" 0, "slnt" 0, "wdth" 92;`.
  - Section labels & headings (`h1, h2, h3, .about-label, .row-label`): `12px`, weight `600`, sentence case, `font-variation-settings: "ROND" 20, "slnt" 0, "wdth" 100;`.
- **Code & Path Font (`code, pre, kbd, samp` only):** `var(--editor-font-family, "Google Sans Code", monospace)` with `font-variation-settings: normal`. Do not apply monospace families to non-code selectors; wrap file paths and technical identifiers in `<code>` tags.
- **Unicode-Range Safety:** Embedded base64 slices in `app/fonts.css` (`latin`, `latin-ext`, `vietnamese`) MUST preserve exact `unicode-range` descriptors so status glyphs (`✓`, `✗`, `●`, `○`, `◌`, `◐`, `■`) render via system symbol fallback cleanly without `.notdef` tofu boxes.

## Color & Host Variable Isolation

All palette tokens live in `app/app.css` and MUST be declared on `:root, body, :root[data-theme="light"], :root[data-theme="light"] body` and `:root[data-theme="dark"], :root[data-theme="dark"] body` (plus `@media (prefers-color-scheme: dark)`). Never reference `var(--muted)` or `var(--faint)` directly, as Antigravity's host `theme-change` injects shadcn surface `--muted` onto `:root`.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#f8f9fa` | `#131417` | Pane canvas background |
| `--surface` | `#ffffff` | `#1b1d22` | Inspection drawer / elevated surface |
| `--fg` | `#1f1f1f` | `#e8eaed` | Primary ink |
| `--fg-2` | `#3c4043` | `#c4c7c5` | Secondary readable ink |
| `--fg-muted` | `#5f6368` | `#9aa0a6` | Muted metadata, labels, inactive text |
| `--fg-faint` | `#70757a` | `#80868b` | Subtle separators and counters |
| `--line` | `color-mix(in srgb, var(--fg) 10%, transparent)` | `color-mix(in srgb, var(--fg) 10%, transparent)` | Hairline rules |
| `--accent` | `#0b57d0` | `#8ab4f8` | Active step, focus ring, primary action link |
| `--ok` | `#188038` | `#6dd58c` | Success / completed / fine take |
| `--warn` | `#b06000` | `#fcc934` | Concern take / waiting agents |
| `--bad` | `#c5221f` | `#f28b82` | Error / against take / stopped state |

Derived surfaces (`--hover`, `--accent-soft`, `--bad-soft`) use `color-mix(in srgb, ..., transparent)`. Never use indigo/purple accents (`#4f46e5`, etc.) or decorative gradients.

## Locked Core Layout (Preserve)

Keep the simple top conversation & turn structure unchanged:
- **About block (`#about-group`, never dimmed between turns):** `Session` (plus `updating…` / `update failed` slot), full-width `.full-rule`, `Topic` (`show all` action opening Topics drawer), full-width `.full-rule`.
- **Turn block (`#turn-group`, dims via `.is-stale` while planning without report; individual prior `Ask` / `Take` rows dim via `.row-sec.is-stale-field` at `opacity: 0.56` when fresh `Ask` or live `working` steps appear before `Take` lands):** unified `54px 1fr` two-column `.row-sec` grid with `62px`-indented `.part-rule` hairlines for:
  - `Ask` (always expanded, renders `wants` only with no line clamp or toggle)
  - `Take` (inline `<mark> <label>` + optional `: <why>`, no pill border)
  - `Plan` (`✓` / `●` / `○` / `✗` / `–` steps from native `update_steps` with `intent.json` fallback)
  - `Result` (end-of-turn `Outcome` triage: inline `<mark> <label>` + optional `: <summary>` and `checking…` slot, 0–3 muted bullet items, and quiet verification evidence line; no pill chrome)
  - `Used` (interactive ledger rows)

## Re-Engineered Chrome Contract

1. **Subagent Tree (`.agent-tree`):** Replace ASCII `├`/`└` box-drawing chars with a crisp `1px solid var(--line)` left guide rail (`border-left`) aligned cleanly under the parent step glyph column. Show status glyph (`◌`/`✓`/`✗`/`○`/`■`), medium-weight agent name, muted brief, and quiet right-aligned model text (no boxed pill chrome). Fold past 3 agents with `… N more` / `… less`.
2. **`Used` Ledger Rows (`.used-card`):** Tight tabular columns inside the `54px 1fr` row body: `58px` lowercase category (`files`, `memory`, `learnings`, `skills`, `shell`, `web`, `agents`) in `--fg-muted`, right-aligned `22px` main count (`--accent` when active, `--fg-2` when done/idle), optional `+N` agent count in `--fg-faint`, `<code>` comma-separated short names in `Google Sans Code` (tagging saved/extracted memory items and captured learnings with `--ok` `+slug` previews), subtle `--hover` fill on hover, and quiet `›` chevron revealed on hover/focus.
3. **Unified Single Bottom HUD Footer (`.hud-footer#telemetry-bar`):** Replace the double-stacked status bar + 2-cell boxed table with one cohesive flat footer pinned at the bottom:
   - Top `1.5px` integrated `#context-bar` / `#context-fill` micro-rail (quiet `1px` hairline when 0%).
   - Row 1 (`#status-row`): live status indicator on the left — spinner glyph (`◐`, rotating, reduced-motion safe) and telegraphic wording for working (`working…` / `working`), `◐ planning…`, `◌ waiting · N agent(s)` (`waiting (N)` at mid, `waiting` at tiny), finished triage states `✓ done at HH:MM` / `? needs input at HH:MM` / `! caveats at HH:MM` / `✗ blocked at HH:MM`, `■ stopped at HH:MM` — with tabular `#step-summary-pill` (`0/3 steps` or `… steps`) beside it and `#context-chip` (`ctx 18.4k · 2%`) right-aligned. Wording adapts to the pane width, measured on the footer (`≥380px` full, `≥280px` trimmed, bare below).
   - Row 2 (`.hud-meta-row`): quiet single-line inline strip (no bordered grid, no dark slab, no floating hover tooltip overlays that clip) with the `#watchdog-chip` alone, no label word — `9s · 2 steps · 3 tools`, segments dropping as the pane narrows (tools below 280px, steps below 200px) — plus `#watchdog-alert-badge` only on alert. Clicking either chip opens `#details-drawer` in `telemetry` mode.
4. **Redesigned Inspection Sheet (`#details-drawer`) & Empty/Planning States:**
   - Flat bottom sheet (`--surface`, `1px solid var(--line)`, `10px 10px 0 0` radius, subtle backdrop, `Esc` / backdrop / `×` dismiss, `prefers-reduced-motion` safe) handling four modes:
     - `topics`: hairline-divided reverse-chronological list (no per-item boxed borders), `#N` index in `--fg-faint`, live accent dot + `current` marker on index 0.
     - `used`: `<code>` path rows showing directory prefix in `--fg-muted` and basename in `--fg`, external `↗` links for web URLs, right-aligned tabular `×N` + quiet source word, and `Main` / `@worker` group headers shown only when multiple readers or a subagent contributed. `memory` splits main items into `Captured & extracted` vs `Read`, and `learnings` splits main items into `Captured` vs `Read`, both with 2-line muted excerpts, `--ok` action tags (`captured`, `updated`, `remembered`, `extracted`, `consolidated`), optional `earlier` cue, click-to-open in a new `fileView` / `/api/memory-view` tab, and hover `peek` action opening `memory-doc`.
     - `memory-doc`: inline safe markdown reader with `←` back to the active list (`Memory` or `Learnings`) and `Open tab ↗` action.
     - `telemetry`: clean key-value ledger for **Context** (Model, Total/Input/Cache/Output tokens, Window %, Source) and **Watchdog** (State, Elapsed, Turn Steps/Tools, Alert detail).
   - **Empty State (`#empty-note`):** Calm two-line empty state (`Nothing yet` + `Turn plan, status, and used context.`).
   - **Planning Notice (`#planning-banner`):** Quiet inline indicator line (`◐ Planning…`) without a heavy tinted pill box.
