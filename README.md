# Kitsune Notifications

Millennium plugin that moves Steam desktop notification toasts from the
default bottom-right corner to the top-right corner of the screen.

## What it does

Steam shows notification toasts (friend online, achievement, etc.) at the
bottom-right corner by default. This plugin intercepts the toast popup creation
in the SharedJSContext and repositions each toast to the top-right corner using
`SetWindowPos` from a Lua FFI backend.

## How it works

1. Hooks `window.open` in the SharedJSContext.
2. When a popup with name `notificationtoasts_<N>_desktop` is created,
   schedules a single Lua callable to fire 1000ms later (after Steam's
   slide-in animation completes).
3. The Lua backend walks top-level windows, finds the toast by size + class +
   title heuristics, and calls `SetWindowPos` to move it to the top-right.
4. The HWND is cached so subsequent calls within the toast's lifetime are
   cheap.

## Install

Drop the plugin folder into `<Steam>/millennium/plugins/kitsune-notifications/`
with these files:

```
kitsune-notifications/
├── plugin.json
├── backend/main.lua
└── .millennium/Dist/index.js
```

Then enable it in the Millennium plugin settings.

## Build from source

```bash
pnpm install
pnpm build
```

Output goes to `.millennium/Dist/index.js`. Copy that, `plugin.json`, and
`backend/main.lua` to the Steam plugin folder.

## Known limitations

**Flicker during entry/exit animations.** The toast briefly appears at the
bottom-right during Steam's slide-in animation (~1 second), then teleports to
the top-right and stays there for the rest of its lifetime (~4 seconds). On
the exit animation Steam also drags it back down. Fixing this requires fighting
Steam's animation with many `SetWindowPos` calls, which triggers the bug
described below.

**Millennium Lua VM bug under high FFI load.** During development we hit a
deterministic crash at offset `0x789EF` inside `millennium.luavm64.exe`,
reading `NULL+0x91`. The crash fires after roughly 3-5 toast move attempts
when the work-per-call is high (large Z-order walks + `inspect_window` +
`SetWindowPos`). This is a bug inside Millennium's bundled LuaJIT and is not
fixable from the plugin side. We worked around it by:

- One IPC call per toast (no multi-shot follow-ups).
- Aggressive size pre-filter in the window walk (size → PID → full inspect).
- All FFI cdata buffers (`RECT`, `WCHAR[256]`, `DWORD[1]`, etc.) are module-
  level and reused, not allocated per call.
- Cached steamwebhelper.exe PID set with a 60s TTL.
- HWND cache keyed by pointer value so the second through Nth move attempts
  on the same toast skip the heavy walk entirely.

These reduce per-walk FFI calls by ~50% versus a straightforward
implementation, which is enough to stay under the crash threshold for normal
toast frequency.

## Architecture references

This plugin reuses the safe FFI pattern from
[`kitsune-mica`](https://github.com/K1tsune12/kitsune-mica): no FFI callbacks,
GetTopWindow + GetWindow(GW_HWNDNEXT) chain instead of EnumWindows, pointer-
sized `ULONG_PTR`/`SIZE_T` typedefs (LLP64).

## License

MIT.
