import {
	callable,
	DialogControlsSection,
	Dropdown,
	DropdownItem,
	type SingleDropdownOption,
	SliderField,
	ToggleField,
} from '@steambrew/client';

declare global {
	interface Window {
		SP_REACT: {
			useState: <T>(initial: T | (() => T)) => [T, (value: T | ((prev: T) => T)) => void];
			useEffect: (cb: () => void | (() => void), deps?: unknown[]) => void;
			createElement: unknown;
			Fragment: unknown;
		};
	}
	// We compile JSX with `jsxFactory: window.SP_REACT.createElement`, so raw
	// host elements (`<div>`, `<>`) need this stub to satisfy the type-checker.
	namespace JSX {
		// eslint-disable-next-line @typescript-eslint/no-empty-interface
		interface IntrinsicElements { [elem: string]: any; }
	}
}
const { useState, useEffect } = window.SP_REACT;

export const POSITION_BOTTOM_RIGHT = 0;
export const POSITION_TOP_RIGHT = 1;
export const POSITION_TOP_LEFT = 2;
export const POSITION_BOTTOM_LEFT = 3;

export const EFFECT_SLIDE = 'slide';
export const EFFECT_FADE = 'fade';
export const EFFECT_SCALE = 'scale';
export const EFFECT_BOUNCE = 'bounce';

export const SLIDE_AUTO = 'auto';
export const SLIDE_UP = 'up';
export const SLIDE_DOWN = 'down';
export const SLIDE_LEFT = 'left';
export const SLIDE_RIGHT = 'right';

export const SOUND_CAT_MESSAGE = 'message';
export const SOUND_CAT_GENERAL = 'general';
export const SOUND_CAT_ACHIEVEMENT = 'achievement';
export const SOUND_CAT_FRIEND_ONLINE = 'friend_online';
export const SOUND_CAT_FRIEND_INGAME = 'friend_ingame';

export const SUPPORTED_SOUND_FORMATS = 'MP3, WAV, OGG, M4A, FLAC, Opus';
const SOUND_MIME: Record<string, string> = {
	mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', opus: 'audio/ogg',
};

export const DEFAULTS = {
	enabled: true,
	position: POSITION_TOP_RIGHT,
	effect: EFFECT_SLIDE,
	slideDirection: SLIDE_AUTO,
	marginTopPx: 16,
	marginRightPx: 16,
	marginBottomPx: 16,
	marginLeftPx: 16,
	debugMode: false,
	overlayEnabled: false,
	overlayPosition: POSITION_TOP_RIGHT,
	overlayEffect: EFFECT_SLIDE,
	overlaySlideDirection: SLIDE_AUTO,
	overlayMarginTopPx: 16,
	overlayMarginRightPx: 16,
	overlayMarginBottomPx: 16,
	overlayMarginLeftPx: 16,
	customSoundsEnabled: false,
	soundFileMessage: '',
	soundFileGeneral: '',
	soundFileAchievement: '',
	soundFileFriendOnline: '',
	soundFileFriendInGame: '',
};

export type Settings = typeof DEFAULTS;
export type SettingsKey = keyof Settings;

const POSITION_OPTIONS = [
	{ data: POSITION_TOP_RIGHT, label: 'Top right' },
	{ data: POSITION_TOP_LEFT, label: 'Top left' },
	{ data: POSITION_BOTTOM_RIGHT, label: 'Bottom right' },
	{ data: POSITION_BOTTOM_LEFT, label: 'Bottom left' },
];

const EFFECT_OPTIONS = [
	{ data: EFFECT_SLIDE, label: 'Slide' },
	{ data: EFFECT_FADE, label: 'Fade' },
	{ data: EFFECT_SCALE, label: 'Scale' },
	{ data: EFFECT_BOUNCE, label: 'Bounce' },
];

const SLIDE_DIRECTION_OPTIONS = [
	{ data: SLIDE_AUTO, label: 'Auto (from corner)' },
	{ data: SLIDE_UP, label: 'Up' },
	{ data: SLIDE_DOWN, label: 'Down' },
	{ data: SLIDE_LEFT, label: 'Left' },
	{ data: SLIDE_RIGHT, label: 'Right' },
];

// Slide direction only affects effects that travel (Slide / Bounce).
const effectTravels = (effect: string): boolean =>
	effect === EFFECT_SLIDE || effect === EFFECT_BOUNCE;

const SECTION_GENERAL = 'general';
const SECTION_OVERLAY = 'overlay';
const SECTION_SOUNDS = 'sounds';
const SECTION_ADVANCED = 'advanced';
const SECTION_OPTIONS = [
	{ data: SECTION_GENERAL, label: 'General' },
	{ data: SECTION_OVERLAY, label: 'In-game' },
	{ data: SECTION_SOUNDS, label: 'Sounds' },
	{ data: SECTION_ADVANCED, label: 'Advanced' },
];

const loadSettingsRaw = callable<[], string>('LoadSettings');
const saveSettingsRaw = callable<[{ payload: string }], string>('SaveSettings');
const importSoundRaw = callable<[{ payload: string }], string>('ImportSound');
const loadSoundRaw = callable<[{ payload: string }], string>('LoadSound');
const clearSoundRaw = callable<[{ payload: string }], string>('ClearSound');

const soundMime = (ext: string): string => SOUND_MIME[ext] || 'audio/mpeg';

export const soundSettingKey = (category: string): SettingsKey =>
	category === SOUND_CAT_MESSAGE ? 'soundFileMessage' :
	category === SOUND_CAT_ACHIEVEMENT ? 'soundFileAchievement' :
	category === SOUND_CAT_FRIEND_ONLINE ? 'soundFileFriendOnline' :
	category === SOUND_CAT_FRIEND_INGAME ? 'soundFileFriendInGame' : 'soundFileGeneral';

// Reads the stored file from disk each time so a replaced sound is never stale.
export async function getSoundDataUri(category: string): Promise<string | null> {
	try {
		const r = JSON.parse(await loadSoundRaw({ payload: JSON.stringify({ category }) }));
		if (r.found && r.data) return `data:${soundMime(r.ext)};base64,${r.data}`;
	} catch (_e) {}
	return null;
}

type Listener = (s: Settings) => void;
const listeners = new Set<Listener>();
export function subscribeSettings(cb: Listener): () => void {
	listeners.add(cb);
	return () => { listeners.delete(cb); };
}

// v0.1/v0.2 stored a single `marginPx` and a `delayMs`. Spread the legacy
// margin across the four directional keys and drop `delayMs`.
function migrate(stored: Record<string, any>): Partial<Settings> {
	const legacyMargin = typeof stored.marginPx === 'number' ? stored.marginPx : undefined;
	const out: Record<string, any> = { ...stored };
	for (const key of ['marginTopPx', 'marginRightPx', 'marginBottomPx', 'marginLeftPx']) {
		if (out[key] === undefined && legacyMargin !== undefined) out[key] = legacyMargin;
	}
	delete out.marginPx;
	delete out.delayMs;
	return out as Partial<Settings>;
}

export async function loadSettings(): Promise<Settings> {
	try {
		const raw = await loadSettingsRaw();
		const parsed = JSON.parse(raw) as Record<string, any>;
		return { ...DEFAULTS, ...migrate(parsed) };
	} catch (_e) {
		return { ...DEFAULTS };
	}
}

async function saveSettings(s: Settings): Promise<void> {
	try {
		await saveSettingsRaw({ payload: JSON.stringify(s) });
		listeners.forEach((cb) => { try { cb(s); } catch (_e) {} });
	} catch (_e) {}
}

type MarginKey =
	| 'marginTopPx' | 'marginRightPx' | 'marginBottomPx' | 'marginLeftPx'
	| 'overlayMarginTopPx' | 'overlayMarginRightPx' | 'overlayMarginBottomPx' | 'overlayMarginLeftPx';

export const SettingsPanel = () => {
	const [settings, setSettings] = useState<Settings | null>(null);
	const [section, setSection] = useState<string>(SECTION_GENERAL);

	useEffect(() => {
		loadSettings().then(setSettings);
	}, []);

	if (!settings) {
		return <DialogControlsSection>Loading settings…</DialogControlsSection>;
	}

	const update = <K extends SettingsKey>(key: K, value: Settings[K]) => {
		const next: Settings = { ...settings, [key]: value };
		setSettings(next);
		saveSettings(next);
	};

	const marginSlider = (key: MarginKey, label: string, disabled: boolean) => (
		<SliderField
			label={label}
			value={settings[key]}
			min={0}
			max={100}
			step={1}
			showValue={true}
			valueSuffix=" px"
			resetValue={DEFAULTS[key]}
			disabled={disabled}
			onChange={(v: number) => update(key, v)}
		/>
	);

	// Steam's HTML file input is blocked in CEF, so use the native picker which returns a path.
	const onPickSound = async (category: string) => {
		try {
			const sc: any = (window as any).SteamClient;
			const path = await sc?.System?.OpenFileDialog?.({
				strTitle: 'Choose notification sound',
				rgFilters: [{ strFileTypeName: 'Audio', rFilePatterns: ['*.mp3', '*.wav', '*.ogg', '*.m4a', '*.flac', '*.opus'] }],
			});
			if (!path || typeof path !== 'string') return;
			const res = JSON.parse(await importSoundRaw({ payload: JSON.stringify({ category, path }) }));
			if (res.success) {
				update(soundSettingKey(category) as any, res.file as any);
			}
		} catch (_e) {}
	};

	// Removing the custom file makes Steam's original sound play again.
	const onRestoreDefault = async (category: string) => {
		try { await clearSoundRaw({ payload: JSON.stringify({ category }) }); } catch (_e) {}
		update(soundSettingKey(category) as any, '' as any);
	};

	const onPreviewSound = async (category: string) => {
		try {
			const uri = await getSoundDataUri(category);
			if (uri) { const a = new Audio(uri); a.currentTime = 0; a.play().catch(() => {}); }
		} catch (_e) {}
	};

	const soundBtn = { padding: '6px 14px', borderRadius: '2px', background: 'rgba(255,255,255,0.1)', cursor: 'pointer', fontSize: '13px' };

	const soundRow = (category: string, label: string) => {
		const fileName = settings[soundSettingKey(category)] as string;
		const off = !settings.customSoundsEnabled;
		return (
			<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '8px 0', opacity: off ? 0.4 : 1 }}>
				<div style={{ display: 'flex', flexDirection: 'column' }}>
					<span>{label}</span>
					<span style={{ opacity: 0.6, fontSize: '12px' }}>{fileName || 'Default Steam sound'}</span>
				</div>
				<div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
					{fileName ? <span style={{ ...soundBtn, pointerEvents: off ? 'none' : 'auto' }} onClick={() => { if (!off) onPreviewSound(category); }}>Play</span> : null}
					<span style={{ ...soundBtn, pointerEvents: off ? 'none' : 'auto' }} onClick={() => { if (!off) onPickSound(category); }}>Choose</span>
					{fileName ? <span style={{ ...soundBtn, pointerEvents: off ? 'none' : 'auto' }} onClick={() => { if (!off) onRestoreDefault(category); }}>Restore default</span> : null}
				</div>
			</div>
		);
	};

	const soundsSection = (
		<DialogControlsSection>
			<ToggleField
				label="Custom notification sounds"
				description={`Play your own sound per notification type. Supported formats: ${SUPPORTED_SOUND_FORMATS}.`}
				checked={settings.customSoundsEnabled}
				onChange={(checked: boolean) => update('customSoundsEnabled', checked)}
			/>
			{soundRow(SOUND_CAT_MESSAGE, 'Messages')}
			{soundRow(SOUND_CAT_GENERAL, 'General notifications')}
			{soundRow(SOUND_CAT_ACHIEVEMENT, 'Achievements')}
			{soundRow(SOUND_CAT_FRIEND_ONLINE, 'Friend came online')}
			{soundRow(SOUND_CAT_FRIEND_INGAME, 'Friend started a game')}
			<div style={{ opacity: 0.6, fontSize: '12px', paddingTop: '6px' }}>
				Note: the two friend sounds ride on Steam's own friend events, which have a long-standing, well-known Steam bug - the sound can play with no notification, be delayed, or fire in bursts. That timing is Steam's, not the plugin's.
			</div>
		</DialogControlsSection>
	);

	const generalSection = (
		<DialogControlsSection>
			<ToggleField
				label="Enabled"
				description="Move new notification toasts to the chosen corner."
				checked={settings.enabled}
				onChange={(checked: boolean) => update('enabled', checked)}
			/>
			<DropdownItem
				label="Position"
				description="Corner where toasts appear."
				rgOptions={POSITION_OPTIONS}
				selectedOption={settings.position}
				disabled={!settings.enabled}
				onChange={(opt: SingleDropdownOption) => update('position', opt.data as number)}
			/>
			<DropdownItem
				label="Animation"
				description="Entry/exit effect for toasts. Slide and Bounce move off-screen; Fade and Scale stay in place."
				rgOptions={EFFECT_OPTIONS}
				selectedOption={settings.effect}
				disabled={!settings.enabled}
				onChange={(opt: SingleDropdownOption) => update('effect', opt.data as string)}
			/>
			<DropdownItem
				label="Slide direction"
				description="Direction toasts slide from/to. Auto follows the chosen corner. Only applies to Slide and Bounce."
				rgOptions={SLIDE_DIRECTION_OPTIONS}
				selectedOption={settings.slideDirection}
				disabled={!settings.enabled || !effectTravels(settings.effect)}
				onChange={(opt: SingleDropdownOption) => update('slideDirection', opt.data as string)}
			/>
			{marginSlider('marginTopPx', 'Top margin', !settings.enabled)}
			{marginSlider('marginRightPx', 'Right margin', !settings.enabled)}
			{marginSlider('marginBottomPx', 'Bottom margin', !settings.enabled)}
			{marginSlider('marginLeftPx', 'Left margin', !settings.enabled)}
		</DialogControlsSection>
	);

	const overlaySection = (
		<DialogControlsSection>
			<ToggleField
				label="Use different settings while playing"
				description="When on, notifications use a separate corner and margins while a game is running."
				checked={settings.overlayEnabled}
				onChange={(checked: boolean) => update('overlayEnabled', checked)}
			/>
			<DropdownItem
				label="Position"
				description="Corner used while a game is running."
				rgOptions={POSITION_OPTIONS}
				selectedOption={settings.overlayPosition}
				disabled={!settings.overlayEnabled}
				onChange={(opt: SingleDropdownOption) => update('overlayPosition', opt.data as number)}
			/>
			<DropdownItem
				label="Animation"
				description="Entry/exit effect used while a game is running."
				rgOptions={EFFECT_OPTIONS}
				selectedOption={settings.overlayEffect}
				disabled={!settings.overlayEnabled}
				onChange={(opt: SingleDropdownOption) => update('overlayEffect', opt.data as string)}
			/>
			<DropdownItem
				label="Slide direction"
				description="Direction toasts slide while a game is running. Auto follows the chosen corner. Only applies to Slide and Bounce."
				rgOptions={SLIDE_DIRECTION_OPTIONS}
				selectedOption={settings.overlaySlideDirection}
				disabled={!settings.overlayEnabled || !effectTravels(settings.overlayEffect)}
				onChange={(opt: SingleDropdownOption) => update('overlaySlideDirection', opt.data as string)}
			/>
			{marginSlider('overlayMarginTopPx', 'Top margin', !settings.overlayEnabled)}
			{marginSlider('overlayMarginRightPx', 'Right margin', !settings.overlayEnabled)}
			{marginSlider('overlayMarginBottomPx', 'Bottom margin', !settings.overlayEnabled)}
			{marginSlider('overlayMarginLeftPx', 'Left margin', !settings.overlayEnabled)}
		</DialogControlsSection>
	);

	const advancedSection = (
		<DialogControlsSection>
			<ToggleField
				label="Debug logging"
				description="Write diagnostic events to the plugin's log file. Useful when reporting issues."
				checked={settings.debugMode}
				onChange={(checked: boolean) => update('debugMode', checked)}
			/>
		</DialogControlsSection>
	);

	const sectionContent =
		section === SECTION_OVERLAY ? overlaySection :
		section === SECTION_SOUNDS ? soundsSection :
		section === SECTION_ADVANCED ? advancedSection :
		generalSection;

	return (
		<>
			<div style={{ padding: '0 0 8px 0' }}>
				<Dropdown
					rgOptions={SECTION_OPTIONS}
					selectedOption={section}
					onChange={(opt: SingleDropdownOption) => setSection(opt.data as string)}
				/>
			</div>
			{sectionContent}
		</>
	);
};
