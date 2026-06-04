import {
	callable,
	DialogControlsSection,
	DropdownItem,
	type SingleDropdownOption,
	SliderField,
	ToggleField,
} from '@steambrew/client';

// React is provided by Steam as window.SP_REACT — there's no `react` npm package
// installed; the project's tsconfig points jsxFactory at window.SP_REACT.createElement.
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
	delayMs: 1000,
	marginPx: 16,
};

export type Settings = typeof DEFAULTS;
export type SettingsKey = keyof Settings;

const POSITION_OPTIONS = [
	{ data: POSITION_TOP_RIGHT, label: 'Top right' },
	{ data: POSITION_TOP_LEFT, label: 'Top left' },
	{ data: POSITION_BOTTOM_RIGHT, label: 'Bottom right' },
	{ data: POSITION_BOTTOM_LEFT, label: 'Bottom left' },
];

// Backend callables — settings persistence is owned by the Lua side because
// Millennium's @steambrew/client pluginConfig API is a no-op stub.
const loadSettingsRaw = callable<[], string>('LoadSettings');
const saveSettingsRaw = callable<[{ payload: string }], string>('SaveSettings');

// Listeners for in-process settings changes (so other modules can refresh too).
type Listener = (s: Settings) => void;
const listeners = new Set<Listener>();
export function subscribeSettings(cb: Listener): () => void {
	listeners.add(cb);
	return () => { listeners.delete(cb); };
}

export async function loadSettings(): Promise<Settings> {
	try {
		const raw = await loadSettingsRaw();
		const parsed = JSON.parse(raw) as Partial<Settings>;
		return { ...DEFAULTS, ...parsed };
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

	return (
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

			<SliderField
				label="Move delay"
				description="Milliseconds to wait after a toast is created before moving it. Higher values let Steam's slide-in animation finish first (less flicker, but the toast spends longer at the bottom)."
				value={settings.delayMs}
				min={0}
				max={3000}
				step={50}
				showValue={true}
				editableValue={true}
				valueSuffix=" ms"
				resetValue={DEFAULTS.delayMs}
				disabled={!settings.enabled}
				onChange={(v: number) => update('delayMs', v)}
			/>

			<SliderField
				label="Edge margin"
				description="Pixels of space between the toast and the closest screen edges."
				value={settings.marginPx}
				min={0}
				max={100}
				step={1}
				showValue={true}
				editableValue={true}
				valueSuffix=" px"
				resetValue={DEFAULTS.marginPx}
				disabled={!settings.enabled}
				onChange={(v: number) => update('marginPx', v)}
			/>
		</DialogControlsSection>
	);
};
