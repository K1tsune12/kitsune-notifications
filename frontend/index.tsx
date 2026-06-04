import { callable } from '@steambrew/client';

// 0 = bottom-right (Steam default), 1 = top-right, 2 = top-left, 3 = bottom-left.
const DEFAULT_POSITION = 1;

// Two separate callables (the IPC layer eats boolean args; see v11 notes).
const discoverRaw = callable<[{ position: number }], boolean>('DiscoverAndMoveToasts');
const cachedRaw = callable<[{ position: number }], boolean>('MoveCachedToasts');

const moveDiscover = (position: number = DEFAULT_POSITION): Promise<boolean> =>
	discoverRaw({ position });
const moveCached = (position: number = DEFAULT_POSITION): Promise<boolean> =>
	cachedRaw({ position });

// Architecture: hook window.open in SharedJSContext (which creates Steam popups).
// We fire EXACTLY ONE Lua IPC call per toast, at 700ms after creation, which is
// after Steam's slide-in animation completes. Reasons for the single call:
//   - Millennium's Lua VM has a deterministic crash at offset 0x789EF reading
//     NULL+0x91 under high IPC volume. The fewer round-trips per toast, the
//     more notifications we can serve before the VM goes down.
//   - Earlier multi-shot designs (5–7 timers per toast) crashed by the 3rd
//     notification (~15 IPC calls). One call per toast scales to ~30+ toasts
//     before risk becomes noticeable.
//   - The visible cost: the toast briefly shows at bottom-right during Steam's
//     ~500ms slide-in animation, then jumps to top-right at 700ms. Acceptable.

type OriginalOpenFunction = (
	url?: string,
	target?: string,
	features?: string,
	replace?: boolean,
) => Window | null;

const originalOpen: OriginalOpenFunction = window.open;

declare global {
	interface Window {
		KitsuneNotifications?: {
			move: (position?: number) => Promise<boolean>;
		};
	}
}

// Serialize: if a previous Lua call hasn't completed, skip new ones.
let inFlight = 0;
const fire = (fn: () => Promise<boolean>) => {
	if (inFlight > 0) return;
	inFlight++;
	fn().catch(() => {}).finally(() => { inFlight--; });
};

// 1000ms: Steam's slide-in animation runs over the first ~500-800ms, so this
// fires after the toast has settled at the bottom. The user sees the toast
// briefly at bottom, then it teleports to top-right and stays for the rest of
// its lifetime (~4s). Earlier fires (700ms) caught the tail of the animation
// and produced a more jarring flicker.
const MOVE_DELAY_MS = 1000;

window.open = function (url?: string, target?: string, features?: string, replace?: boolean): Window | null {
	const result = originalOpen(url, target, features, replace);
	if (target && target.indexOf('notificationtoasts_') === 0) {
		setTimeout(() => fire(() => moveDiscover(DEFAULT_POSITION)), MOVE_DELAY_MS);
	}
	return result;
};

export default async function PluginMain() {
	(window as any).KitsuneNotifications = {
		move: (position?: number) => moveCached(position),
	};
}
