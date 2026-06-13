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

export const DEFAULTS = {
	enabled: true,
	position: POSITION_TOP_RIGHT,
	marginTopPx: 16,
	marginRightPx: 16,
	marginBottomPx: 16,
	marginLeftPx: 16,
	debugMode: false,
	overlayEnabled: false,
	overlayPosition: POSITION_TOP_RIGHT,
	overlayMarginTopPx: 16,
	overlayMarginRightPx: 16,
	overlayMarginBottomPx: 16,
	overlayMarginLeftPx: 16,
};

export type Settings = typeof DEFAULTS;
export type SettingsKey = keyof Settings;

const POSITION_OPTIONS = [
	{ data: POSITION_TOP_RIGHT, label: 'Top right' },
	{ data: POSITION_TOP_LEFT, label: 'Top left' },
	{ data: POSITION_BOTTOM_RIGHT, label: 'Bottom right' },
	{ data: POSITION_BOTTOM_LEFT, label: 'Bottom left' },
];

const SECTION_GENERAL = 'general';
const SECTION_OVERLAY = 'overlay';
const SECTION_ADVANCED = 'advanced';
const SECTION_OPTIONS = [
	{ data: SECTION_GENERAL, label: 'General' },
	{ data: SECTION_OVERLAY, label: 'In-game' },
	{ data: SECTION_ADVANCED, label: 'Advanced' },
];

const loadSettingsRaw = callable<[], string>('LoadSettings');
const saveSettingsRaw = callable<[{ payload: string }], string>('SaveSettings');

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
