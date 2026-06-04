import { callable, definePlugin, IconsModule } from '@steambrew/client';
import {
	DEFAULTS,
	loadSettings,
	type Settings,
	SettingsPanel,
	subscribeSettings,
} from './Settings';

// Millennium IPC mangles multi-key object args (a `{position, margin}` JS
// object reaches Lua with the wrong values), so we serialize as a JSON string
// and the Lua side parses it. This matches the pattern hltb-for-millennium uses.
const discoverRaw = callable<[{ payload: string }], boolean>('DiscoverAndMoveToasts');

// Process-lifetime cache of current settings. The settings panel calls
// `saveSettings` after each change which notifies via `subscribeSettings`, so
// this stays in sync with whatever the user picked in the panel.
let current: Settings = { ...DEFAULTS };

// Serialize callable invocations to keep IPC pressure off Millennium's Lua VM.
let inFlight = 0;
const fire = (fn: () => Promise<boolean>) => {
	if (inFlight > 0) return;
	inFlight++;
	fn().catch(() => {}).finally(() => { inFlight--; });
};

type OriginalOpenFunction = (
	url?: string,
	target?: string,
	features?: string,
	replace?: boolean,
) => Window | null;

const originalOpen: OriginalOpenFunction = window.open;

window.open = function (url?: string, target?: string, features?: string, replace?: boolean): Window | null {
	const result = originalOpen(url, target, features, replace);
	if (current.enabled && target && target.indexOf('notificationtoasts_') === 0) {
		const payload = JSON.stringify({ position: current.position, margin: current.marginPx });
		setTimeout(() => {
			fire(() => discoverRaw({ payload }));
		}, current.delayMs);
	}
	return result;
};

// Load persisted settings + subscribe to future writes.
loadSettings().then((s) => { current = s; });
subscribeSettings((s) => { current = s; });

export default definePlugin(() => ({
	// Millennium's runtime requires `title`, `icon`, AND `content` to mount the
	// plugin into the sidebar navigation panel. Without all three "Configure"
	// stays disabled. (The TypeScript Plugin interface marks title as optional
	// but the runtime check enforces it.)
	title: 'Kitsune Notifications',
	icon: <IconsModule.Settings />,
	content: <SettingsPanel />,
}) as any);
