import { callable, definePlugin, IconsModule } from '@steambrew/client';
import {
	DEFAULTS,
	loadSettings,
	POSITION_BOTTOM_LEFT,
	POSITION_BOTTOM_RIGHT,
	POSITION_TOP_LEFT,
	POSITION_TOP_RIGHT,
	type Settings,
	SettingsPanel,
	subscribeSettings,
} from './Settings';

// Hook each toast popup's own SteamClient.Window.MoveTo so every Steam-driven
// reposition (entry slide, periodic snap-back) lands at our configured corner.

interface SteamPopup {
	window?: Window & { name?: string };
}

interface SteamPopupManager {
	AddPopupCreatedCallback(cb: (popup: SteamPopup) => void): { Unregister(): void };
	AddPopupDestroyedCallback(cb: (popup: SteamPopup) => void): { Unregister(): void };
}

let current: Settings = { ...DEFAULTS };

const debugLog = callable<[{ payload: string }], string>('DebugLog');
const dlog = (msg: string) => {
	if (!current.debugMode) return;
	debugLog({ payload: msg }).catch(() => {});
};

const TOAST_W_FALLBACK = 425;
const TOAST_H_FALLBACK = 105;
const CASCADE_GAP = 6;
const MAX_SLOTS = 16;
const ANIM_DURATION_MS = 320;
const TOAST_LIFETIME_MS = 5000;
const OFF_SCREEN_BUFFER = 50;
const HOOK_RETRY_LIMIT = 60;
const HOOK_RETRY_MS = 500;
const DOC_READY_RETRY_LIMIT = 20;
const DOC_READY_RETRY_MS = 25;
const FRAME_FALLBACK_MS = 16;

// First-available-slot allocator for cascade stacking.
const slots: (string | null)[] = new Array(MAX_SLOTS).fill(null);

function claimSlot(name: string): number {
	for (let i = 0; i < MAX_SLOTS; i++) {
		if (slots[i] === null) { slots[i] = name; return i; }
	}
	return 0;
}

function releaseSlot(name: string): void {
	for (let i = 0; i < MAX_SLOTS; i++) {
		if (slots[i] === name) { slots[i] = null; return; }
	}
}

let gamesRunning = 0;
const isInGame = (): boolean => gamesRunning > 0;
const useOverlayProfile = (s: Settings): boolean => s.overlayEnabled && isInGame();

const activePosition = (s: Settings): number =>
	useOverlayProfile(s) ? s.overlayPosition : s.position;

function activeMargins(s: Settings): { mt: number; mr: number; mb: number; ml: number } {
	if (useOverlayProfile(s)) {
		return { mt: s.overlayMarginTopPx, mr: s.overlayMarginRightPx, mb: s.overlayMarginBottomPx, ml: s.overlayMarginLeftPx };
	}
	return { mt: s.marginTopPx, mr: s.marginRightPx, mb: s.marginBottomPx, ml: s.marginLeftPx };
}

function computeTargetXY(win: Window, settings: Settings, slot: number): { x: number; y: number } {
	const screenW = win.screen?.availWidth ?? 1920;
	const screenH = win.screen?.availHeight ?? 1080;
	const w = win.outerWidth || TOAST_W_FALLBACK;
	const h = win.outerHeight || TOAST_H_FALLBACK;
	const cascadeStep = h + CASCADE_GAP;
	const { mt, mr, mb, ml } = activeMargins(settings);

	switch (activePosition(settings)) {
		case POSITION_TOP_RIGHT:
			return { x: screenW - w - mr, y: mt + slot * cascadeStep };
		case POSITION_TOP_LEFT:
			return { x: ml, y: mt + slot * cascadeStep };
		case POSITION_BOTTOM_LEFT:
			return { x: ml, y: screenH - h - mb - slot * cascadeStep };
		case POSITION_BOTTOM_RIGHT:
		default:
			return { x: screenW - w - mr, y: screenH - h - mb - slot * cascadeStep };
	}
}

// translateY offset used for the slide-in/slide-out keyframes.
function slideTransform(position: number): string {
	switch (position) {
		case POSITION_TOP_RIGHT:
		case POSITION_TOP_LEFT:
			return 'translateY(-110%)';
		case POSITION_BOTTOM_RIGHT:
		case POSITION_BOTTOM_LEFT:
		default:
			return 'translateY(110%)';
	}
}

// Targets html (not body) so the entire document slides - body alone left the
// popup's outer wrapper visible as a ghost frame.
function injectAnimationCss(win: any, position: number): void {
	const doc = win.document;
	if (!doc) return;
	const startTransform = slideTransform(position);
	const css = `
		@keyframes kitsune-toast-in {
			from { transform: ${startTransform}; opacity: 0; }
			to   { transform: translateY(0);    opacity: 1; }
		}
		@keyframes kitsune-toast-out {
			from { transform: translateY(0);    opacity: 1; }
			to   { transform: ${startTransform}; opacity: 0; }
		}
		html {
			animation: kitsune-toast-in ${ANIM_DURATION_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
		}
		html.kitsune-exiting {
			animation: kitsune-toast-out ${ANIM_DURATION_MS}ms cubic-bezier(0.4, 0, 0.6, 1) both;
		}
		html, body { background: transparent !important; }
	`;
	const style = doc.createElement('style');
	style.setAttribute('data-kitsune', 'animation');
	style.textContent = css;
	(doc.head || doc.documentElement).appendChild(style);
}

function triggerExitAnim(win: any): void {
	try {
		win.document?.documentElement?.classList?.add('kitsune-exiting');
	} catch (_e) { /* doc may be gone */ }
}

function handlePopupCreated(popup: SteamPopup): void {
	const name = popup.window?.name;
	if (!current.enabled) return;
	if (!name || name.indexOf('notificationtoasts_') !== 0) return;

	const win: any = popup.window;
	if (!win) return;

	const sc = win.SteamClient;
	if (!sc?.Window?.MoveTo) {
		dlog(`no SteamClient.Window.MoveTo on toast ${name}`);
		return;
	}

	const slot = claimSlot(name);
	dlog(`toast ${name} hooked into slot ${slot}`);

	// During exit, the hook returns the animated Y so OS-level effects
	// (Mica/Acrylic backdrop) slide off with the window as one unit.
	let exitAnimating = false;
	let exitY = 0;

	const baseTarget = () => computeTargetXY(win, current, slot);
	const targetFor = () => {
		const t = baseTarget();
		return exitAnimating ? { x: t.x, y: exitY } : t;
	};

	// Snapshot the original before we replace it - needed to drive the rAF
	// exit slide without recursing through our own hook.
	const origMoveToRaw: ((x: number, y: number, scale: boolean) => unknown) | null =
		typeof sc.Window.MoveTo === 'function' ? sc.Window.MoveTo.bind(sc.Window) : null;

	// 3rd arg `applyBrowserScaleOrDPIValue` is required; pass through what
	// Steam sent (or false if the caller only sent x, y).
	try {
		if (origMoveToRaw) {
			sc.Window.MoveTo = (_a: number, _b: number, ...rest: unknown[]) => {
				const t = targetFor();
				return origMoveToRaw(t.x, t.y, rest.length > 0 ? (rest[0] as boolean) : false);
			};
		}
	} catch (e) { dlog(`MoveTo hook failed: ${(e as Error)?.message ?? e}`); }

	try {
		if (typeof sc.Window.MoveToLocation === 'function') {
			const origMoveToLoc = sc.Window.MoveToLocation.bind(sc.Window);
			sc.Window.MoveToLocation = (..._args: unknown[]) => {
				const t = targetFor();
				return origMoveToLoc(t.x, t.y);
			};
		}
	} catch (e) { dlog(`MoveToLocation hook failed: ${(e as Error)?.message ?? e}`); }

	// Initial move in case Steam already started positioning before our hook landed.
	try {
		const t = targetFor();
		sc.Window.MoveTo(t.x, t.y, false);
	} catch (e) { dlog(`initial MoveTo failed: ${(e as Error)?.message ?? e}`); }

	// Inject the slide-in keyframes (retry until the doc is ready).
	const tryInject = (attempts: number) => {
		if (win.document?.documentElement) {
			injectAnimationCss(win, activePosition(current));
		} else if (attempts < DOC_READY_RETRY_LIMIT) {
			setTimeout(() => tryInject(attempts + 1), DOC_READY_RETRY_MS);
		}
	};
	tryInject(0);

	// CSS slides the body, the rAF loop slides the OS window - both end at the
	// same off-screen Y so OS-level effects leave together.
	const runExitSlide = () => {
		if (!origMoveToRaw) return;
		triggerExitAnim(win);

		const start = baseTarget();
		const screenH = win.screen?.availHeight ?? 1080;
		const h = win.outerHeight || TOAST_H_FALLBACK;
		const pos = activePosition(current);
		const isTop = pos === POSITION_TOP_RIGHT || pos === POSITION_TOP_LEFT;
		const offY = isTop ? -h - OFF_SCREEN_BUFFER : screenH + OFF_SCREEN_BUFFER;

		exitAnimating = true;
		const startedAt = (win as any).performance?.now?.() ?? Date.now();
		const step = () => {
			const now = (win as any).performance?.now?.() ?? Date.now();
			const tProgress = Math.min((now - startedAt) / ANIM_DURATION_MS, 1);
			const eased = 1 - Math.pow(1 - tProgress, 3);
			exitY = Math.round(start.y + (offY - start.y) * eased);
			try { origMoveToRaw(start.x, exitY, false); } catch (_e) {}
			if (tProgress < 1) {
				(win as any).requestAnimationFrame?.(step) ?? setTimeout(step, FRAME_FALLBACK_MS);
			}
		};
		(win as any).requestAnimationFrame?.(step) ?? setTimeout(step, FRAME_FALLBACK_MS);
	};

	setTimeout(runExitSlide, TOAST_LIFETIME_MS - ANIM_DURATION_MS);
}

function handlePopupDestroyed(popup: SteamPopup): void {
	const name = popup.window?.name;
	if (!name || name.indexOf('notificationtoasts_') !== 0) return;
	releaseSlot(name);
}

function installHook(attempt: number = 0): void {
	const mgr: SteamPopupManager | undefined = Reflect.get(globalThis, 'g_PopupManager');
	if (!mgr) {
		if (attempt < HOOK_RETRY_LIMIT) {
			setTimeout(() => installHook(attempt + 1), HOOK_RETRY_MS);
		} else {
			dlog('g_PopupManager never appeared');
		}
		return;
	}
	try {
		mgr.AddPopupCreatedCallback(handlePopupCreated);
		mgr.AddPopupDestroyedCallback(handlePopupDestroyed);
		dlog('callbacks registered');
	} catch (e) {
		dlog(`callback registration failed: ${(e as Error)?.message ?? e}`);
	}
}

interface AppLifetimeNotification { unAppID: number; bRunning: boolean; }

// Track running games so `activePosition` can swap to the overlay profile.
function installGameLifecycleHook(attempt: number = 0): void {
	const sc: any = Reflect.get(globalThis, 'SteamClient');
	const reg = sc?.GameSessions?.RegisterForAppLifetimeNotifications;
	if (typeof reg !== 'function') {
		if (attempt < HOOK_RETRY_LIMIT) {
			setTimeout(() => installGameLifecycleHook(attempt + 1), HOOK_RETRY_MS);
		} else {
			dlog('GameSessions.RegisterForAppLifetimeNotifications never appeared');
		}
		return;
	}
	try {
		reg.call(sc.GameSessions, (n: AppLifetimeNotification) => {
			if (n.bRunning) {
				gamesRunning++;
				dlog(`game ${n.unAppID} started, running=${gamesRunning}`);
			} else if (gamesRunning > 0) {
				gamesRunning--;
				dlog(`game ${n.unAppID} ended, running=${gamesRunning}`);
			}
		});
		dlog('game lifecycle hook registered');
	} catch (e) {
		dlog(`game lifecycle hook failed: ${(e as Error)?.message ?? e}`);
	}
}

loadSettings().then((s) => { current = s; });
subscribeSettings((s) => { current = s; });
installHook();
installGameLifecycleHook();

export default definePlugin(() => ({
	title: 'Kitsune Notifications',
	icon: <IconsModule.Settings />,
	content: <SettingsPanel />,
}) as any);
