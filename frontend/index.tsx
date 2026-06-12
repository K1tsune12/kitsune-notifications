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

// v0.3.0 architecture: hook each toast popup's own `SteamClient.Window.MoveTo`
// to redirect every Steam-initiated reposition to our configured corner.
// Each popup carries its own SteamClient instance, so the hook is naturally
// scoped per-popup and doesn't affect the main Steam window or other popups.

const debugLog = callable<[{ payload: string }], string>('DebugLog');
const dlog = (msg: string) => {
	if (!current.debugMode) return;
	debugLog({ payload: msg }).catch(() => {});
};

interface SteamPopup {
	title: string;
	window?: Window & { name?: string };
}

interface SteamPopupManager {
	AddPopupCreatedCallback(cb: (popup: SteamPopup) => void): { Unregister(): void };
	AddPopupDestroyedCallback(cb: (popup: SteamPopup) => void): { Unregister(): void };
	GetExistingPopup(name: string): SteamPopup | undefined;
}

let current: Settings = { ...DEFAULTS };

const TOAST_W_FALLBACK = 425;
const TOAST_H_FALLBACK = 105;
const CASCADE_GAP = 6;
const MAX_SLOTS = 16;  // 16 simultaneously-visible toasts is more than anyone needs

// Slot table: slot[i] holds the popup name occupying that vertical slot, or null.
// First free slot is assigned to each new toast; slot frees on toast destroy.
const slots: (string | null)[] = new Array(MAX_SLOTS).fill(null);

function claimSlot(name: string): number {
	for (let i = 0; i < MAX_SLOTS; i++) {
		if (slots[i] === null) { slots[i] = name; return i; }
	}
	return 0;  // overflow: stack on top of slot 0
}

function releaseSlot(name: string): void {
	for (let i = 0; i < MAX_SLOTS; i++) {
		if (slots[i] === name) { slots[i] = null; return; }
	}
}

function computeTargetXY(
	win: Window,
	settings: Settings,
	slot: number,
): { x: number; y: number } {
	const screenW = win.screen?.availWidth ?? 1920;
	const screenH = win.screen?.availHeight ?? 1080;
	const w = win.outerWidth || TOAST_W_FALLBACK;
	const h = win.outerHeight || TOAST_H_FALLBACK;
	const cascadeStep = h + CASCADE_GAP;
	const { marginTopPx: mt, marginRightPx: mr, marginBottomPx: mb, marginLeftPx: ml } = settings;

	switch (settings.position) {
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

const ANIM_DURATION_MS = 320;
const TOAST_LIFETIME_MS = 5000;  // Steam's default toast visibility window

// Returns the off-screen translate direction for the slide animation, based on
// the configured position. Top positions slide down from above; bottom slide
// up from below. The window itself stays put — we slide the BODY content.
function slideTransform(position: number): string {
	switch (position) {
		case POSITION_TOP_RIGHT:
		case POSITION_TOP_LEFT:
			return 'translateY(-110%)';  // 110% so the box-shadow fully clears too
		case POSITION_BOTTOM_RIGHT:
		case POSITION_BOTTOM_LEFT:
		default:
			return 'translateY(110%)';
	}
}

function injectAnimationCss(win: any, position: number): void {
	const doc = win.document;
	if (!doc) return;
	const startTransform = slideTransform(position);
	// Animate `html` (not just body) so EVERYTHING inside the popup window —
	// the toast card, any wrapper elements, and the window's own background
	// region — goes invisible together during the slide-out. Animating body
	// alone left the popup's outer container visible as a dark "ghost" frame.
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
		/* Keep html itself transparent so when its content slides out the popup
		   window has nothing left to paint. */
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
	} catch (_e) { /* doc may be gone already */ }
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

	// Animation state for exit slide. When `exitAnimating` is true, the
	// MoveTo hook returns the animated Y (and X) instead of the static target.
	// This makes EVERY MoveTo — Steam's internal animation frames AND our own
	// rAF-driven calls — render at the same Y, so the window and its Mica /
	// Acrylic backdrop slide off as a single cohesive unit.
	let exitAnimating = false;
	let exitY = 0;

	const baseTarget = () => computeTargetXY(win, current, slot);
	const targetFor = () => {
		const t = baseTarget();
		if (exitAnimating) return { x: t.x, y: exitY };
		return t;
	};

	// Save the ORIGINAL MoveTo before installing the hook. We need this for
	// the rAF-driven exit slide so we can move the window past our hook.
	const origMoveToRaw: ((x: number, y: number, scale: boolean) => unknown) | null =
		typeof sc.Window.MoveTo === 'function'
			? sc.Window.MoveTo.bind(sc.Window)
			: null;

	// Hook MoveTo. The 3rd arg `applyBrowserScaleOrDPIValue` is required —
	// pass through what Steam sent (or false if it called with only 2 args).
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

	// Proactive initial move (Steam may have already started sliding before our
	// callback fired).
	try {
		const t = targetFor();
		sc.Window.MoveTo(t.x, t.y, false);
	} catch (e) { dlog(`initial MoveTo failed: ${(e as Error)?.message ?? e}`); }

	// Inject slide-in animation now (or wait for doc to become available).
	const tryInject = (attempts: number) => {
		if (win.document?.documentElement) {
			injectAnimationCss(win, current.position);
		} else if (attempts < 20) {
			setTimeout(() => tryInject(attempts + 1), 25);
		}
	};
	tryInject(0);

	// Drive the exit slide ourselves. The CSS html animation slides the body
	// contents while the rAF loop slides the WINDOW itself — both end at the
	// same off-screen Y, so the Mica/Acrylic backdrop blur (from kitsune-mica)
	// and any other OS-level window effects slide off with the toast as one
	// unit, no lingering ghost frame.
	const runExitSlide = () => {
		if (!origMoveToRaw) return;
		triggerExitAnim(win);  // CSS slide-out for body contents

		const start = baseTarget();
		const screenH = win.screen?.availHeight ?? 1080;
		const h = win.outerHeight || TOAST_H_FALLBACK;
		const isTop = current.position === POSITION_TOP_RIGHT || current.position === POSITION_TOP_LEFT;
		const offY = isTop ? -h - 50 : screenH + 50;

		exitAnimating = true;
		const startedAt = (win as any).performance?.now?.() ?? Date.now();
		const step = () => {
			const now = (win as any).performance?.now?.() ?? Date.now();
			const tProgress = Math.min((now - startedAt) / ANIM_DURATION_MS, 1);
			const eased = 1 - Math.pow(1 - tProgress, 3);  // ease-out cubic
			exitY = Math.round(start.y + (offY - start.y) * eased);
			try { origMoveToRaw(start.x, exitY, false); } catch (_e) {}
			if (tProgress < 1) {
				(win as any).requestAnimationFrame?.(step) ?? setTimeout(step, 16);
			}
		};
		(win as any).requestAnimationFrame?.(step) ?? setTimeout(step, 16);
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
		if (attempt < 60) {
			setTimeout(() => installHook(attempt + 1), 500);
		} else {
			dlog('g_PopupManager never appeared after 30s');
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

loadSettings().then((s) => { current = s; });
subscribeSettings((s) => { current = s; });
installHook();

export default definePlugin(() => ({
	title: 'Kitsune Notifications',
	icon: <IconsModule.Settings />,
	content: <SettingsPanel />,
}) as any);
