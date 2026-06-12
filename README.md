# Kitsune Notifications

Millennium plugin that moves Steam desktop notification toasts to any screen
corner, with directional margins, cascade stacking and a slide animation in
both directions.

Settings apply live — no Steam restart needed.

## Configure panel

`Millennium → Plugins → Kitsune Notifications → Configure`:

| Section  | Setting        | Description                                                                | Default     |
|----------|----------------|----------------------------------------------------------------------------|-------------|
| —        | Enabled        | Master toggle. When off, Steam's default behavior is left alone.           | On          |
| —        | Position       | Target corner: Top right / Top left / Bottom right / Bottom left.          | Top right   |
| Margins  | Top            | Distance from the top of the work area.                                    | 16 px       |
| Margins  | Right          | Distance from the right edge.                                              | 16 px       |
| Margins  | Bottom         | Distance from the bottom of the work area.                                 | 16 px       |
| Margins  | Left           | Distance from the left edge.                                               | 16 px       |
| Advanced | Debug logging  | Writes diagnostic events to `<plugin-dir>/logs/...` for issue reporting.   | Off         |

Only two of the four margins are actually used at any time — they're paired
with the chosen position (Top right uses Top + Right; Bottom left uses Bottom
+ Left; etc.). Tweaking the others is harmless, just stored for when you
switch positions later.

Settings persist to `settings.json` in the plugin folder.

## How it works

1. Hooks `g_PopupManager.AddPopupCreatedCallback` to catch every popup Steam
   creates in the SharedJSContext.
2. Filters by window name pattern `notificationtoasts_<N>_desktop`.
3. For each matching popup, **replaces** the popup's own
   `SteamClient.Window.MoveTo` (each popup carries its own SteamClient
   instance — the hook is naturally scoped). Every internal Steam call that
   would reposition the toast is now redirected to the configured corner,
   plus the cascade offset for that slot.
4. **Cascade stacking** — up to 16 simultaneous toasts each get their own
   vertical slot. Top positions cascade downward; bottom positions cascade
   upward. Slots are reclaimed when toasts close.
5. **Slide-in animation** — a CSS keyframe is injected into the toast
   document; the toast body slides in from above (Top positions) or below
   (Bottom positions) over 320 ms.
6. **Slide-out animation** — at the end of the toast's lifetime, a
   `requestAnimationFrame` loop drives the OS window itself off-screen via
   the saved-original `MoveTo` (bypassing our own hook), while the CSS
   keyframe slides the body out in sync. The whole window — including any
   Mica/Acrylic backdrop applied by `kitsune-mica` or similar — leaves
   together, with no leftover ghost frame.

Why all this instead of a simple `Win32 SetWindowPos`? The earlier versions
of this plugin (v0.1, v0.2) did exactly that, via Lua FFI. They worked, but
hit two hard problems:

- Steam re-positions toasts continuously during their lifetime, so a one-shot
  move loses the race. Multi-shot retries hammered the IPC channel.
- Millennium's bundled LuaJIT has a deterministic VM crash under FFI volume
  (offset `0x789EF`, `NULL+0x91`), tripping after roughly 5 toasts. Not
  fixable from the plugin side.

Hooking the popup's own `SteamClient.Window.MoveTo` sidesteps both: every
Steam reposition lands at our corner because the function itself redirects,
and no Lua FFI is involved in moves anymore. The Lua backend exists only to
persist `settings.json`.

## Install

Drop the plugin folder into `<Steam>/millennium/plugins/kitsune-notifications/`
with these files:

```
kitsune-notifications/
├── plugin.json
├── backend/main.lua
└── .millennium/Dist/index.js
```

Enable it in Millennium settings and click Configure to set your preferred
position and margins. Changes apply to new notifications immediately — no
restart needed.

## Build from source

```bash
pnpm install
pnpm build
```

Output goes to `.millennium/Dist/index.js`. Copy that, `plugin.json`, and
`backend/main.lua` to the Steam plugin folder.

## Settings migration

Upgrading from v0.1 / v0.2 keeps your old margin choice:

- `marginPx` (legacy single value) → populates all four `marginTopPx`,
  `marginRightPx`, `marginBottomPx`, `marginLeftPx`.
- `delayMs` (legacy) → dropped, no longer needed (the hook is instant).

The migration runs once on first load of v0.3+; the legacy keys are removed
from `settings.json` after that.

## License

MIT.
