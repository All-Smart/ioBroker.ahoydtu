// Shared types between main.ts and deviceManagement.ts
// In a separate file so main.ts stays export-free (avoids ESBuild ESM warning)

import type * as utils from "@iobroker/adapter-core";

export interface InverterConfig {
	id: number;
	enabled: boolean;
	name: string;
	serial: string;
	channels: number;
	ch_name: string[];
	ch_max_pwr: number[];
}

export interface IAhoydtuAdapter extends utils.AdapterInstance {
	getKnownInverters(): Map<number, InverterConfig>;
	getInverterByDeviceId(deviceId: string): InverterConfig | undefined;
	sanitizeDeviceId(name: string): string;
	rediscoverInverters(): Promise<void>;
	sendInverterControl(inverterId: number, deviceId: string, cmd: string, val: ioBroker.StateValue): Promise<void>;
}
