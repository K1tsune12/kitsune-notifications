import { callable, definePlugin, findModuleExport, IconsModule, modules } from '@steambrew/client';
import {
	DEFAULTS,
	EFFECT_BOUNCE,
	EFFECT_FADE,
	EFFECT_SCALE,
	getSoundDataUri,
	loadSettings,
	POSITION_BOTTOM_LEFT,
	POSITION_BOTTOM_RIGHT,
	POSITION_TOP_LEFT,
	POSITION_TOP_RIGHT,
	type Settings,
	SettingsPanel,
	SLIDE_DOWN,
	SLIDE_LEFT,
	SLIDE_RIGHT,
	SLIDE_UP,
	SOUND_CAT_ACHIEVEMENT,
	SOUND_CAT_FRIEND_INGAME,
	SOUND_CAT_FRIEND_ONLINE,
	SOUND_CAT_GENERAL,
	SOUND_CAT_MESSAGE,
	soundCatForProfile,
	soundSettingKey,
	soundVolumeKey,
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

// Timestamp of the last toast popup, so custom sounds only fire alongside a real
// notification (Steam also plays the message sound at login and in focused chats).
let lastToastAt = 0;
const TOAST_SOUND_WINDOW_MS = 2000;

// Steam replays friend status sounds in bulk when a game launches/closes; swallow that burst.
let friendSuppressUntil = 0;
const FRIEND_REFRESH_SUPPRESS_MS = 5000;

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

const activeEffect = (s: Settings): string =>
	useOverlayProfile(s) ? s.overlayEffect : s.effect;

const activeSlideDirection = (s: Settings): string =>
	useOverlayProfile(s) ? s.overlaySlideDirection : s.slideDirection;

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

// Off-screen transform; SLIDE_AUTO follows the corner, otherwise explicit.
function slideTransform(position: number, direction: string): string {
	switch (direction) {
		case SLIDE_UP: return 'translateY(-110%)';
		case SLIDE_DOWN: return 'translateY(110%)';
		case SLIDE_LEFT: return 'translateX(-110%)';
		case SLIDE_RIGHT: return 'translateX(110%)';
	}
	// SLIDE_AUTO
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

// Slide/Bounce move the OS window off-screen; Fade/Scale animate in place.
function effectMovesWindow(effect: string): boolean {
	return effect !== EFFECT_FADE && effect !== EFFECT_SCALE;
}

interface Keyframes {
	inFrom: string;
	inTo: string;
	outFrom: string;
	outTo: string;
	inEasing: string;
	outEasing: string;
	origin: string;
}

// transform-origin so Scale zooms from the toast's corner, not the center.
function cornerOrigin(position: number): string {
	switch (position) {
		case POSITION_TOP_RIGHT: return 'top right';
		case POSITION_TOP_LEFT: return 'top left';
		case POSITION_BOTTOM_LEFT: return 'bottom left';
		case POSITION_BOTTOM_RIGHT:
		default: return 'bottom right';
	}
}

// Per-effect entry/exit keyframe state.
function keyframesFor(effect: string, position: number, direction: string): Keyframes {
	const off = slideTransform(position, direction);
	switch (effect) {
		case EFFECT_FADE:
			return {
				inFrom: 'opacity: 0;',
				inTo: 'opacity: 1;',
				outFrom: 'opacity: 1;',
				outTo: 'opacity: 0;',
				inEasing: 'ease-out',
				outEasing: 'ease-in',
				origin: 'center',
			};
		case EFFECT_SCALE:
			// Pronounced zoom with overshoot so it reads apart from Fade.
			return {
				inFrom: 'transform: scale(0.6); opacity: 0;',
				inTo: 'transform: scale(1); opacity: 1;',
				outFrom: 'transform: scale(1); opacity: 1;',
				outTo: 'transform: scale(0.6); opacity: 0;',
				inEasing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
				outEasing: 'cubic-bezier(0.5, 0, 0.75, 0)',
				origin: cornerOrigin(position),
			};
		case EFFECT_BOUNCE:
			// Same travel as slide but an overshoot easing for a springy entrance.
			return {
				inFrom: `transform: ${off}; opacity: 0;`,
				inTo: 'transform: translateY(0); opacity: 1;',
				outFrom: 'transform: translateY(0); opacity: 1;',
				outTo: `transform: ${off}; opacity: 0;`,
				inEasing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
				outEasing: 'cubic-bezier(0.4, 0, 0.6, 1)',
				origin: 'center',
			};
		default: // EFFECT_SLIDE
			return {
				inFrom: `transform: ${off}; opacity: 0;`,
				inTo: 'transform: translateY(0); opacity: 1;',
				outFrom: 'transform: translateY(0); opacity: 1;',
				outTo: `transform: ${off}; opacity: 0;`,
				inEasing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
				outEasing: 'cubic-bezier(0.4, 0, 0.6, 1)',
				origin: 'center',
			};
	}
}

// Targets html (not body) so the whole document animates without a ghost frame.
function injectAnimationCss(win: any, effect: string, position: number, direction: string): void {
	const doc = win.document;
	if (!doc) return;
	const k = keyframesFor(effect, position, direction);
	const css = `
		@keyframes kitsune-toast-in {
			from { ${k.inFrom} }
			to   { ${k.inTo} }
		}
		@keyframes kitsune-toast-out {
			from { ${k.outFrom} }
			to   { ${k.outTo} }
		}
		html {
			transform-origin: ${k.origin};
			animation: kitsune-toast-in ${ANIM_DURATION_MS}ms ${k.inEasing} both;
		}
		html.kitsune-exiting {
			animation: kitsune-toast-out ${ANIM_DURATION_MS}ms ${k.outEasing} both;
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
	if (!name || name.indexOf('notificationtoasts_') !== 0) return;
	lastToastAt = Date.now();
	if (!current.enabled) return;

	const win: any = popup.window;
	if (!win) return;

	const sc = win.SteamClient;
	if (!sc?.Window?.MoveTo) {
		dlog(`no SteamClient.Window.MoveTo on toast ${name}`);
		return;
	}

	const slot = claimSlot(name);
	dlog(`toast ${name} hooked into slot ${slot}`);

	// During exit the hook returns the animated point so the backdrop moves too.
	let exitAnimating = false;
	let exitX = 0;
	let exitY = 0;

	const baseTarget = () => computeTargetXY(win, current, slot);
	const targetFor = () => {
		const t = baseTarget();
		return exitAnimating ? { x: exitX, y: exitY } : t;
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
			injectAnimationCss(win, activeEffect(current), activePosition(current), activeSlideDirection(current));
		} else if (attempts < DOC_READY_RETRY_LIMIT) {
			setTimeout(() => tryInject(attempts + 1), DOC_READY_RETRY_MS);
		}
	};
	tryInject(0);

	// CSS animates the content; the rAF loop slides the OS window in sync.
	const runExitSlide = () => {
		triggerExitAnim(win);
		if (!origMoveToRaw) return;

		// Fade/Scale: park the window off-screen after the fade so the OS backdrop doesn't linger.
		if (!effectMovesWindow(activeEffect(current))) {
			const parkOffScreen = () => {
				const start = baseTarget();
				const screenH = win.screen?.availHeight ?? 1080;
				exitX = start.x;
				exitY = screenH + OFF_SCREEN_BUFFER;
				exitAnimating = true;
				try { origMoveToRaw(exitX, exitY, false); } catch (_e) {}
			};
			setTimeout(parkOffScreen, ANIM_DURATION_MS);
			return;
		}

		const start = baseTarget();
		const screenW = win.screen?.availWidth ?? 1920;
		const screenH = win.screen?.availHeight ?? 1080;
		const w = win.outerWidth || TOAST_W_FALLBACK;
		const h = win.outerHeight || TOAST_H_FALLBACK;
		const pos = activePosition(current);
		const isTop = pos === POSITION_TOP_RIGHT || pos === POSITION_TOP_LEFT;
		const dir = activeSlideDirection(current);

		// Resolve the off-screen end point. Auto leaves vertically per corner.
		let endX = start.x;
		let endY = start.y;
		if (dir === SLIDE_LEFT) endX = -w - OFF_SCREEN_BUFFER;
		else if (dir === SLIDE_RIGHT) endX = screenW + OFF_SCREEN_BUFFER;
		else if (dir === SLIDE_UP) endY = -h - OFF_SCREEN_BUFFER;
		else if (dir === SLIDE_DOWN) endY = screenH + OFF_SCREEN_BUFFER;
		else endY = isTop ? -h - OFF_SCREEN_BUFFER : screenH + OFF_SCREEN_BUFFER;

		exitX = start.x;
		exitY = start.y;
		exitAnimating = true;
		const startedAt = (win as any).performance?.now?.() ?? Date.now();
		const step = () => {
			const now = (win as any).performance?.now?.() ?? Date.now();
			const tProgress = Math.min((now - startedAt) / ANIM_DURATION_MS, 1);
			const eased = 1 - Math.pow(1 - tProgress, 3);
			exitX = Math.round(start.x + (endX - start.x) * eased);
			exitY = Math.round(start.y + (endY - start.y) * eased);
			try { origMoveToRaw(exitX, exitY, false); } catch (_e) {}
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
			// A game opening/closing makes Steam re-fire friend status sounds in bulk; mute them briefly.
			friendSuppressUntil = Date.now() + FRIEND_REFRESH_SUPPRESS_MS;
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

// Custom notification sounds: intercept Steam's nav-sound dispatcher and play our
// own audio per toast category, suppressing the default for that category.
const soundCache: Record<string, HTMLAudioElement> = {};

function soundCategoryFor(PN: any, type: any): string | null {
	if (type === PN.ToastAchievement) return SOUND_CAT_ACHIEVEMENT;
	if (type === PN.ToastMisc || type === PN.ToastMiscShort) return SOUND_CAT_GENERAL;
	// Messages are handled via PlayAudioURL (their sound can fire before the toast).
	return null;
}

// `cat` is a resolved category (desktop base id, or 'ig_'-prefixed for in-game).
function hasCustomSound(cat: string): boolean {
	if (!current.customSoundsEnabled) return false;
	return !!(current as any)[soundSettingKey(cat)];
}

// Debounce so the two hooks (PlayNavSound + PlayAudioURL) can't double-fire one toast.
const lastPlayed: Record<string, number> = {};

// Volume (0..1) for a resolved category.
function activeVolume(cat: string): number {
	const v = (current as any)[soundVolumeKey(cat)];
	return Math.max(0, Math.min(1, (typeof v === 'number' ? v : 100) / 100));
}

async function playCustomSound(category: string): Promise<void> {
	const now = Date.now();
	const isFriend = category.indexOf('friend') !== -1;
	const cooldown = isFriend ? 1500 : 300;
	if (lastPlayed[category] && now - lastPlayed[category] < cooldown) return;
	lastPlayed[category] = now;
	try {
		let audio = soundCache[category];
		if (!audio) {
			const uri = await getSoundDataUri(category);
			if (!uri) return;
			audio = new Audio(uri);
			soundCache[category] = audio;
		}
		audio.currentTime = 0;
		audio.volume = activeVolume(category);
		audio.play().catch(() => {});
	} catch (_e) {}
}

// Message toasts can play their sound directly via PlayAudioURL, bypassing PlayNavSound.
const MESSAGE_SOUND_RE = /steam_at_mention|steam_chatroom_notification|ui_steam_message|message_old/i;
const FRIEND_ONLINE_RE = /smoother_friend_online|friend_online/i;
const FRIEND_INGAME_RE = /smoother_friend_join|friend_join/i;
// Friend/message sounds play via AudioPlaybackManager.PlayAudioURL directly, and there are
// several manager instances - hook PlayAudioURL on every export that exposes it.
let audioUrlHookInstalled = false;
function installAudioUrlHook(attempt: number = 0): void {
	if (audioUrlHookInstalled) return;
	let count = 0;
	const wrap = (target: any): boolean => {
		if (!target || typeof target.PlayAudioURL !== 'function' || target.__kitsuneAudioHooked) return false;
		const orig = target.PlayAudioURL;
		target.PlayAudioURL = function (url: any, ...rest: any[]) {
			try {
				if (typeof url === 'string' && MESSAGE_SOUND_RE.test(url)) {
					const rc = soundCatForProfile(SOUND_CAT_MESSAGE, useOverlayProfile(current));
					if (hasCustomSound(rc)) {
						// Always suppress Steam's default; the message sound can fire just before the
						// toast. Play custom only if a toast shows around now (none at login -> stay silent).
						const t0 = Date.now();
						if (t0 - lastToastAt < TOAST_SOUND_WINDOW_MS) playCustomSound(rc);
						else setTimeout(() => { if (lastToastAt >= t0) playCustomSound(rc); }, 600);
						return;
					}
				}
				// Friend status sounds play without a toast (so they are not toast-gated), but Steam
				// re-fires them in bulk on game open/close - swallow that window.
				if (typeof url === 'string') {
					const fbase = FRIEND_INGAME_RE.test(url) ? SOUND_CAT_FRIEND_INGAME
						: FRIEND_ONLINE_RE.test(url) ? SOUND_CAT_FRIEND_ONLINE : null;
					if (fbase) {
						const rc = soundCatForProfile(fbase, useOverlayProfile(current));
						if (hasCustomSound(rc)) {
							if (Date.now() < friendSuppressUntil) return;
							playCustomSound(rc);
							return;
						}
					}
				}
			} catch (_e) {}
			return orig.apply(this, [url, ...rest]);
		};
		target.__kitsuneAudioHooked = true;
		return true;
	};
	try {
		for (const m of (modules as Map<string, any>).values()) {
			for (const mod of [m && m.default, m]) {
				if (!mod || typeof mod !== 'object') continue;
				for (const name in mod) {
					let exp: any;
					try { exp = mod[name]; } catch (_e) { continue; }
					if (!exp) continue;
					// Instance/singleton with PlayAudioURL, or a class whose prototype has it.
					if (typeof exp === 'object' && wrap(exp)) count++;
					else if (typeof exp === 'function' && exp.prototype && wrap(exp.prototype)) count++;
				}
			}
		}
	} catch (_e) {}
	if (count > 0) { audioUrlHookInstalled = true; dlog('audio url hooks installed: ' + count); }
	else if (attempt < HOOK_RETRY_LIMIT) setTimeout(() => installAudioUrlHook(attempt + 1), HOOK_RETRY_MS);
	else dlog('audio url hook: no PlayAudioURL export found');
}

let soundHookInstalled = false;
function installSoundHook(attempt: number = 0): void {
	if (soundHookInstalled) return;
	const mgr: any = findModuleExport((e: any) => e && typeof e.PlayNavSound === 'function' && typeof e.RegisterCallbackOnPlaySound === 'function');
	const PN: any = findModuleExport((e: any) => e && e.ToastAchievement !== undefined && e.ToastMisc !== undefined);
	if (!mgr || !PN || typeof mgr.PlayNavSound !== 'function') {
		if (attempt < HOOK_RETRY_LIMIT) setTimeout(() => installSoundHook(attempt + 1), HOOK_RETRY_MS);
		else dlog('sound manager / PN enum not found');
		return;
	}
	const orig = mgr.PlayNavSound.bind(mgr);
	mgr.PlayNavSound = (type: any, mode: any) => {
		try {
			const base = soundCategoryFor(PN, type);
			if (base) {
				const rc = soundCatForProfile(base, useOverlayProfile(current));
				if (hasCustomSound(rc)) { playCustomSound(rc); return; }
			}
		} catch (_e) {}
		return orig(type, mode);
	};
	soundHookInstalled = true;
	dlog('sound hook installed');
}

// One-time: drop stale sound data URIs cached in localStorage by older builds (now disk is the source).
try { Object.keys(localStorage).filter((k) => k.indexOf('kitsune_sound_') === 0).forEach((k) => localStorage.removeItem(k)); } catch (_e) {}

// Steam syncs friend statuses at startup and replays their sounds; mute that initial burst.
friendSuppressUntil = Date.now() + FRIEND_REFRESH_SUPPRESS_MS;

// Install sound hooks after settings load so debug logging is available during install.
loadSettings().then((s) => { current = s; installSoundHook(); installAudioUrlHook(); });
// Drop cached Audio so a freshly picked sound is reloaded.
subscribeSettings((s) => { current = s; for (const k of Object.keys(soundCache)) delete soundCache[k]; });
installHook();
installGameLifecycleHook();

export default definePlugin(() => ({
	title: 'Kitsune Notifications',
	icon: <IconsModule.Settings />,
	content: <SettingsPanel />,
}) as any);
