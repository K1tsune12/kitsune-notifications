# Kitsune Notifications

Millennium plugin that moves Steam desktop notification toasts to any screen
corner, with directional margins, cascade stacking, slide animation, and a
separate profile that kicks in while you're in a game.

Settings apply live — no Steam restart needed.

## Configure panel

`Millennium → Plugins → Kitsune Notifications → Configure`. Three sections,
picked from the dropdown at the top:

### General

| Setting        | Default      |
|----------------|--------------|
| Enabled        | On           |
| Position       | Top right    |
| Top margin     | 16 px        |
| Right margin   | 16 px        |
| Bottom margin  | 16 px        |
| Left margin    | 16 px        |

Two of the four margins are actually used at any time, paired with the chosen
corner (Top right uses Top + Right; Bottom left uses Bottom + Left; etc.).
Tweaking the others is harmless — they're stored for when you switch
positions later.

### In-game

A separate profile applied automatically while any game is running.

| Setting                                              | Default      |
|------------------------------------------------------|--------------|
| Use different settings while playing                 | Off          |
| Position                                             | Top right    |
| Top / Right / Bottom / Left margin                   | 16 px each   |

When the toggle is on, the plugin watches Steam's game lifecycle and swaps
the active corner + margins as games start and stop. When it's off, the
General profile is used in every situation.

### Advanced

| Setting        | Default | Notes                                              |
|----------------|---------|----------------------------------------------------|
| Debug logging  | Off     | Writes diagnostic events to the plugin's log file. |

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
   document; the toast body slides in from the position-matching edge over
   320 ms.
6. **Slide-out animation** — at the end of the toast's lifetime, a
   `requestAnimationFrame` loop drives the OS window itself off-screen via
   the saved-original `MoveTo` (bypassing our own hook), while the CSS
   keyframe slides the body out in sync. The whole window — including any
   Mica/Acrylic backdrop applied by `kitsune-mica` or similar — leaves
   together, with no leftover ghost frame.
7. **In-game profile swap** — subscribes to
   `SteamClient.GameSessions.RegisterForAppLifetimeNotifications` and, when
   the user enables the in-game profile, swaps `activePosition` /
   `activeMargins` to the overlay values while any game is running. The same
   `MoveTo` hook covers both desktop and in-overlay rendering of the toast
   popup, so no additional plumbing is needed.

The legacy Lua FFI + `SetWindowPos` approach (v0.1, v0.2) was abandoned: it
lost the race against Steam's continuous reposition loop, and tripped a
deterministic crash in Millennium's bundled LuaJIT under FFI volume. Hooking
the popup's own `SteamClient.Window.MoveTo` sidesteps both — every Steam
reposition lands at our corner because the function itself redirects, and no
Lua FFI is involved in moves anymore. The Lua backend exists only to persist
`settings.json` and pipe debug log lines.

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

- `marginPx` (legacy single value) → populates all four directional desktop
  margin keys.
- `delayMs` (legacy) → dropped, no longer needed (the hook is instant).

Upgrading from v0.3 onward is a no-op; the new overlay fields default to
Top right + 16 px margins all around. Unknown keys are filtered on save, so
the file self-cleans on first write.

## License

MIT.
