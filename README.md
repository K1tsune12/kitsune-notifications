# Kitsune Notifications

A Millennium plugin that moves Steam's notification popups to the screen corner you choose, with margins, stacking, entry/exit animations and custom per-type sounds. Settings apply instantly, no Steam restart needed.

## Features
- Pick any corner: top-right, top-left, bottom-right, bottom-left.
- Set the margin on each side.
- Stacks multiple notifications neatly instead of overlapping them.
- Entry/exit animations: slide, fade, scale or bounce, with a choosable slide direction.
- Optional separate position and animation for when you are in a game.
- Custom sounds per notification type (messages, general, achievements, friend online, friend in-game), each with its own volume.
- Separate sound sets for desktop and in-game.

## Configure
Open Millennium, go to Plugins, find Kitsune Notifications and click Configure. There are four sections: General (desktop position, animation and margins), In-game (optional separate profile while a game runs), Sounds (custom audio per notification type), and Advanced (debug logging). Changes save automatically.

## Build
```bash
pnpm install
pnpm build
```

## Changelog
- v0.7.1 - Fixed the message sound playing twice (custom plus Steam's default) and a stray sound at login.
- v0.7.0 - Per-category sound volume, and separate sound sets for desktop and in-game.
- v0.6.0 - Custom sounds per notification type (messages, general, achievements, friend online, friend in-game).
- v0.5.0 - Animation effects (slide, fade, scale, bounce), slide direction, separate in-game animation.
- v0.4.0 - Separate in-game position, new three-section settings panel.
- v0.3.0 - Rewritten for smoother, crash-free repositioning. Added stacking and slide animations.
- v0.2.0 - Choose any corner, adjustable margins.
- v0.1.0 - First release. Moved notifications to the top-right corner.

## License
MIT
