import {
	callable,
	DialogControlsSection,
	DialogControlsSectionHeader,
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
};

export type Settings = typeof DEFAULTS;
export type SettingsKey = keyof Settings;

const POSITION_OPTIONS = [
	{ data: POSITION_TOP_RIGHT, label: 'Top right' },
	{ data: POSITION_TOP_LEFT, label: 'Top left' },
	{ data: POSITION_BOTTOM_RIGHT, label: 'Bottom right' },
	{ data: POSITION_BOTTOM_LEFT, label: 'Bottom left' },
];

const loadSettingsRaw = callable<[], string>('LoadSettings');
const saveSettingsRaw = callable<[{ payload: string }], string>('SaveSettings');

type Listener = (s: Settings) => void;
const listeners = new Set<Listener>();
export function subscribeSettings(cb: Listener): () => void {
	listeners.add(cb);
	return () => { listeners.delete(cb); };
}

// Migration: older versions stored a single `marginPx` and a `delayMs` field.
// If the new directional margin keys are missing, fall back to the legacy value
// so users upgrading don't lose their margin choice. `delayMs` is dropped.
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

export const SettingsPanel = () => {
	const [settings, setSettings] = useState<Settings | null>(null);

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

	const marginSlider = (
		key: 'marginTopPx' | 'marginRightPx' | 'marginBottomPx' | 'marginLeftPx',
		label: string,
		description: string,
	) => (
		<SliderField
			label={label}
			description={description}
			value={settings[key]}
			min={0}
			max={100}
			step={1}
			showValue={true}
			editableValue={true}
			valueSuffix=" px"
			resetValue={DEFAULTS[key]}
			disabled={!settings.enabled}
			onChange={(v: number) => update(key, v)}
		/>
	);

	return (
		<>
			<DialogControlsSection>
				<ToggleField
					label="Enabled"
					description="Move new notification toasts to the chosen corner. Disable to leave Steam's default behavior alone."
					checked={settings.enabled}
					onChange={(checked: boolean) => update('enabled', checked)}
				/>

				<DropdownItem
					label="Position"
					description="Screen corner where toasts should land."
					rgOptions={POSITION_OPTIONS}
					selectedOption={settings.position}
					disabled={!settings.enabled}
					onChange={(opt: SingleDropdownOption) => update('position', opt.data as number)}
				/>
			</DialogControlsSection>

			<DialogControlsSectionHeader>Margins</DialogControlsSectionHeader>
			<DialogControlsSection>
				{marginSlider('marginTopPx', 'Top', 'Space from the top of the work area. Used when Position is Top right or Top left.')}
				{marginSlider('marginRightPx', 'Right', 'Space from the right edge. Used when Position is Top right or Bottom right.')}
				{marginSlider('marginBottomPx', 'Bottom', 'Space from the bottom of the work area. Used when Position is Bottom right or Bottom left.')}
				{marginSlider('marginLeftPx', 'Left', 'Space from the left edge. Used when Position is Top left or Bottom left.')}
			</DialogControlsSection>

			<DialogControlsSectionHeader>Advanced</DialogControlsSectionHeader>
			<DialogControlsSection>
				<ToggleField
					label="Debug logging"
					description="When on, the plugin writes diagnostic events (popup creation, hook installation, errors) to its log file. Useful when reporting a problem — include the log when you open an issue."
					checked={settings.debugMode}
					onChange={(checked: boolean) => update('debugMode', checked)}
				/>
			</DialogControlsSection>
		</>
	);
};
