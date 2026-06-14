# Kitsune Notifications

A Millennium plugin that moves Steam's notification popups to the screen corner you choose, with margins, stacking, and a slide animation. Settings apply instantly, no Steam restart needed.

## Features
- Pick any corner: top-right, top-left, bottom-right, bottom-left.
- Set the margin on each side.
- Stacks multiple notifications neatly instead of overlapping them.
- Smooth slide-in and slide-out animation.
- Optional separate position for when you are in a game.

## Configure
Open Millennium, go to Plugins, find Kitsune Notifications and click Configure. There are three sections: General (desktop position and margins), In-game (optional separate position while a game runs), and Advanced (debug logging). Changes save automatically.

## Build
```bash
pnpm install
pnpm build
```

## Changelog
- v0.4.0 - Separate in-game position, new three-section settings panel.
- v0.3.0 - Rewritten for smoother, crash-free repositioning. Added stacking and slide animations.
- v0.2.0 - Choose any corner, adjustable margins.
- v0.1.0 - First release. Moved notifications to the top-right corner.

## License
MIT
