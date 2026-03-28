/*
 * ioBroker adapter for AhoyDTU (Hoymiles inverter gateway)
 * REST API only - no MQTT
 * Created with @iobroker/create-adapter v3.1.2
 */

import * as utils from "@iobroker/adapter-core";
import axios, { AxiosInstance } from "axios";
import { AhoydtuDeviceManagement } from "./lib/deviceManagement";

// ─── API response types ───────────────────────────────────────────────────────

interface LiveResponse {
	generic: {
		version: string;
		host: string;
		wifi_rssi: number;
		ts_uptime: number;
		ts_now: number;
	};
	refresh: number;
	max_total_pwr: number;
	ch0_fld_names: string[];
	ch0_fld_units: string[];
	fld_names: string[];
	fld_units: string[];
	iv: boolean[];
}

interface InverterConfig {
	id: number;
	enabled: boolean;
	name: string;
	serial: string;
	channels: number;
	ch_name: string[];
	ch_max_pwr: number[];
}

interface InverterListResponse {
	inverter: InverterConfig[];
	interval: string;
}

interface InverterDataResponse {
	id: number;
	enabled: boolean;
	name: string;
	serial: string;
	version: string;
	power_limit_read: number;
	power_limit_ack: boolean;
	max_pwr: number;
	ts_last_success: number;
	generation: number;
	status: number;
	alarm_cnt: number;
	rssi: number;
	ts_max_ac_pwr: number;
	ts_max_temp: number;
	ch: number[][];
	ch_name: string[];
	ch_max_pwr: (number | null)[];
}

interface AuthResponse {
	success: boolean;
	token?: string;
	error?: string;
}

// ─── Field index constants from /api/live ────────────────────────────────────

const CH0_FIELDS = {
	U_AC: 0,
	I_AC: 1,
	P_AC: 2,
	F_AC: 3,
	PF_AC: 4,
	Temp: 5,
	YieldTotal: 6,
	YieldDay: 7,
	P_DC: 8,
	Efficiency: 9,
	Q_AC: 10,
	MaxPower: 11,
	MaxTemp: 12,
};

const DC_FIELDS = {
	U_DC: 0,
	I_DC: 1,
	P_DC: 2,
	YieldDay: 3,
	YieldTotal: 4,
	Irradiation: 5,
	MaxPower: 6,
};

// ─── Adapter class ────────────────────────────────────────────────────────────

// exported for use in deviceManagement.ts
export class Ahoydtu extends utils.Adapter {
	private http: AxiosInstance | null = null;
	private authToken: string | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private knownInverters: Map<number, InverterConfig> = new Map();
	private liveData: LiveResponse | null = null;
	private readonly deviceManagement: AhoydtuDeviceManagement;

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: "ahoydtu",
		});
		this.deviceManagement = new AhoydtuDeviceManagement(this);
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	// ── Public helpers for DeviceManagement ───────────────────────────────────

	/** Returns all known inverters (used by DeviceManagement) */
	public getKnownInverters(): Map<number, InverterConfig> {
		return this.knownInverters;
	}

	/** Returns an InverterConfig by sanitized device ID */
	public getInverterByDeviceId(deviceId: string): InverterConfig | undefined {
		for (const [, inv] of this.knownInverters) {
			if (this.sanitizeId(inv.name) === deviceId) {
				return inv;
			}
		}
		return undefined;
	}

	/** Sanitizes a name to a valid ioBroker object ID segment (public) */
	public sanitizeDeviceId(name: string): string {
		return this.sanitizeId(name);
	}

	/** Re-discovers inverters from DTU (called by DeviceManagement refresh action) */
	public async rediscoverInverters(): Promise<void> {
		this.knownInverters.clear();
		await this.discoverInverters();
	}

	/** Sends a control command to an inverter (public for DeviceManagement) */
	public async sendInverterControl(
		inverterId: number,
		deviceId: string,
		cmd: string,
		val: ioBroker.StateValue,
	): Promise<void> {
		await this.sendControl(inverterId, deviceId, cmd, val);
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────────

	private async onReady(): Promise<void> {
		// Validate config
		if (!this.config.host || this.config.host.trim() === "") {
			this.log.error("No host configured - please set the IP/hostname of your AhoyDTU");
			return;
		}

		const port = this.config.port || 80;
		const interval = Math.max(5, this.config.pollInterval || 15);

		this.log.info(`Connecting to AhoyDTU at ${this.config.host}:${port}, poll interval: ${interval}s`);

		// Create HTTP client
		this.http = axios.create({
			baseURL: `http://${this.config.host.trim()}:${port}`,
			timeout: 10000,
			headers: { "Content-Type": "application/json" },
		});

		// Ensure info channel exists
		await this.setObjectNotExistsAsync("info", {
			type: "channel",
			common: { name: "Adapter information" },
			native: {},
		});

		// Ensure info.connection object exists (ioBroker standard)
		await this.setObjectNotExistsAsync("info.connection", {
			type: "state",
			common: {
				name: "Connection status",
				type: "boolean",
				role: "indicator.connected",
				read: true,
				write: false,
				def: false,
			},
			native: {},
		});

		// Set connection indicator offline initially
		this.setState("info.connection", false, true);

		// Authenticate if password is set
		if (this.config.password && this.config.password.trim() !== "") {
			await this.authenticate();
		}

		// Initial discovery + poll
		try {
			await this.discoverInverters();
			await this.pollInverters();
			this.setState("info.connection", true, true);
		} catch (err) {
			this.log.error(`Initial connection failed: ${(err as Error).message}`);
			this.setState("info.connection", false, true);
		}

		// Start polling timer
		this.pollTimer = setInterval(async () => {
			try {
				await this.pollInverters();
				this.setState("info.connection", true, true);
			} catch (err) {
				this.log.warn(`Poll failed: ${(err as Error).message}`);
				this.setState("info.connection", false, true);
				// Mark all inverters as unreachable
				for (const [, inv] of this.knownInverters) {
					const deviceId = this.sanitizeId(inv.name);
					await this.setStateAsync(`${deviceId}.info.reachable`, false, true);
				}
			}
		}, interval * 1000);

		// Subscribe to writable control states
		this.subscribeStates("*.control.*");
	}

	private onUnload(callback: () => void): void {
		try {
			if (this.pollTimer) {
				clearInterval(this.pollTimer);
				this.pollTimer = null;
			}
			this.setState("info.connection", false, true);
			callback();
		} catch (e) {
			this.log.error(`Error during unload: ${(e as Error).message}`);
			callback();
		}
	}

	// ── Auth ───────────────────────────────────────────────────────────────────

	private async authenticate(): Promise<void> {
		if (!this.http) return;
		try {
			const res = await this.http.post<AuthResponse>("/api/auth", {
				auth: this.config.password,
			});
			if (res.data.success && res.data.token) {
				this.authToken = res.data.token;
				this.log.debug("Authentication successful");
			} else {
				this.log.warn(`Authentication failed: ${res.data.error || "unknown error"}`);
			}
		} catch (err) {
			this.log.warn(`Authentication request failed: ${(err as Error).message}`);
		}
	}

	private getAuthHeaders(): Record<string, string> {
		if (this.authToken) {
			return { token: this.authToken };
		}
		return {};
	}

	// ── Discovery ─────────────────────────────────────────────────────────────

	private async discoverInverters(): Promise<void> {
		if (!this.http) return;

		// Fetch live data for field name/unit mappings
		const liveRes = await this.http.get<LiveResponse>("/api/live", {
			headers: this.getAuthHeaders(),
		});
		this.liveData = liveRes.data;
		this.log.debug(`AhoyDTU firmware: ${this.liveData.generic.version}`);

		// Fetch inverter list
		const listRes = await this.http.get<InverterListResponse>("/api/inverter/list", {
			headers: this.getAuthHeaders(),
		});

		const inverters = listRes.data.inverter.filter((inv) => inv.enabled);
		this.log.info(`Found ${inverters.length} enabled inverter(s)`);

		for (const inv of inverters) {
			this.knownInverters.set(inv.id, inv);
			await this.createInverterObjects(inv);
		}
	}

	// ── Object creation ───────────────────────────────────────────────────────

	private sanitizeId(name: string): string {
		return name
			.toLowerCase()
			.replace(/[^a-z0-9_]/g, "_")
			.replace(/_+/g, "_")
			.replace(/^_|_$/g, "");
	}

	private async createInverterObjects(inv: InverterConfig): Promise<void> {
		const deviceId = this.sanitizeId(inv.name);

		// Device object
		await this.setObjectNotExistsAsync(deviceId, {
			type: "device",
			common: {
				name: inv.name,
				icon: "ahoydtu.png",
			},
			native: {
				id: inv.id,
				serial: inv.serial,
			},
		});

		// ── Info channel ──────────────────────────────────────────────────
		await this.setObjectNotExistsAsync(`${deviceId}.info`, {
			type: "channel",
			common: { name: "Info" },
			native: {},
		});

		const infoStates: Array<[string, ioBroker.StateCommon]> = [
			["name", { name: "Inverter name", type: "string", role: "info.name", read: true, write: false, def: inv.name }],
			["serial", { name: "Serial number", type: "string", role: "info.serial", read: true, write: false, def: inv.serial }],
			["status", {
				name: "Status",
				type: "number",
				role: "indicator",
				read: true,
				write: false,
				states: { 0: "offline", 1: "partial", 2: "online", 3: "was producing", 4: "was available" },
				def: 0,
			}],
			["version", { name: "Firmware version", type: "string", role: "info.firmware", read: true, write: false, def: "" }],
			["alarm_cnt", { name: "Alarm count", type: "number", role: "value", read: true, write: false, def: 0 }],
			["rssi", { name: "RSSI signal strength", type: "number", role: "value", unit: "dBm", read: true, write: false, def: 0 }],
			["last_success", { name: "Last successful contact", type: "number", role: "date.timestamp", read: true, write: false, def: 0 }],
			["max_power", { name: "Max inverter power", type: "number", role: "value.power.max", unit: "W", read: true, write: false, def: inv.ch_max_pwr[0] || 0 }],
			["reachable", { name: "Reachable", type: "boolean", role: "indicator.reachable", read: true, write: false, def: false }],
			["power_limit_pct", { name: "Current power limit", type: "number", role: "value", unit: "%", read: true, write: false, def: 0 }],
		];

		for (const [id, common] of infoStates) {
			await this.setObjectNotExistsAsync(`${deviceId}.info.${id}`, {
				type: "state",
				common,
				native: {},
			});
		}

		// ── AC channel ────────────────────────────────────────────────────
		await this.setObjectNotExistsAsync(`${deviceId}.ac`, {
			type: "channel",
			common: { name: "AC output" },
			native: {},
		});

		const acStates: Array<[string, ioBroker.StateCommon]> = [
			["voltage", { name: "AC voltage", type: "number", role: "value.voltage", unit: "V", read: true, write: false, def: 0 }],
			["current", { name: "AC current", type: "number", role: "value.current", unit: "A", read: true, write: false, def: 0 }],
			["power", { name: "AC power", type: "number", role: "value.power", unit: "W", read: true, write: false, def: 0 }],
			["reactive_power", { name: "AC reactive power", type: "number", role: "value.power", unit: "var", read: true, write: false, def: 0 }],
			["frequency", { name: "AC frequency", type: "number", role: "value.frequency", unit: "Hz", read: true, write: false, def: 0 }],
			["power_factor", { name: "AC power factor", type: "number", role: "value.factor", unit: "%", read: true, write: false, def: 0 }],
			["temperature", { name: "Inverter temperature", type: "number", role: "value.temperature", unit: "°C", read: true, write: false, def: 0 }],
			["yield_day", { name: "Daily yield", type: "number", role: "value.energy", unit: "Wh", read: true, write: false, def: 0 }],
			["yield_total", { name: "Total yield", type: "number", role: "value.energy", unit: "kWh", read: true, write: false, def: 0 }],
			["dc_power", { name: "DC total power", type: "number", role: "value.power", unit: "W", read: true, write: false, def: 0 }],
			["efficiency", { name: "Efficiency", type: "number", role: "value.efficiency", unit: "%", read: true, write: false, def: 0 }],
			["max_ac_power", { name: "Max AC power", type: "number", role: "value.power.max", unit: "W", read: true, write: false, def: 0 }],
		];

		for (const [id, common] of acStates) {
			await this.setObjectNotExistsAsync(`${deviceId}.ac.${id}`, {
				type: "state",
				common,
				native: {},
			});
		}

		// ── DC channels ───────────────────────────────────────────────────
		const dcChannels = inv.channels || 1;
		for (let ch = 1; ch <= dcChannels; ch++) {
			const chName = inv.ch_name[ch - 1] || `Channel ${ch}`;
			await this.setObjectNotExistsAsync(`${deviceId}.dc`, {
				type: "channel",
				common: { name: "DC inputs" },
				native: {},
			});

			await this.setObjectNotExistsAsync(`${deviceId}.dc.ch${ch}`, {
				type: "channel",
				common: { name: chName || `DC Channel ${ch}` },
				native: { channel: ch },
			});

			const dcStates: Array<[string, ioBroker.StateCommon]> = [
				["voltage", { name: `DC voltage CH${ch}`, type: "number", role: "value.voltage", unit: "V", read: true, write: false, def: 0 }],
				["current", { name: `DC current CH${ch}`, type: "number", role: "value.current", unit: "A", read: true, write: false, def: 0 }],
				["power", { name: `DC power CH${ch}`, type: "number", role: "value.power", unit: "W", read: true, write: false, def: 0 }],
				["yield_day", { name: `Daily yield CH${ch}`, type: "number", role: "value.energy", unit: "Wh", read: true, write: false, def: 0 }],
				["yield_total", { name: `Total yield CH${ch}`, type: "number", role: "value.energy", unit: "kWh", read: true, write: false, def: 0 }],
				["irradiation", { name: `Irradiation CH${ch}`, type: "number", role: "value.irradiation", unit: "%", read: true, write: false, def: 0 }],
				["max_power", { name: `Max power CH${ch}`, type: "number", role: "value.power.max", unit: "W", read: true, write: false, def: inv.ch_max_pwr[ch] || 0 }],
			];

			for (const [id, common] of dcStates) {
				await this.setObjectNotExistsAsync(`${deviceId}.dc.ch${ch}.${id}`, {
					type: "state",
					common,
					native: {},
				});
			}
		}

		// ── Control channel ───────────────────────────────────────────────
		await this.setObjectNotExistsAsync(`${deviceId}.control`, {
			type: "channel",
			common: { name: "Control" },
			native: {},
		});

		const controlStates: Array<[string, ioBroker.StateCommon]> = [
			["power", {
				name: "Power on/off",
				type: "boolean",
				role: "switch.power",
				read: true,
				write: true,
				def: true,
			}],
			["restart", {
				name: "Restart inverter",
				type: "boolean",
				role: "button",
				read: false,
				write: true,
				def: false,
			}],
			["power_limit_percent", {
				name: "Power limit (percent)",
				type: "number",
				role: "level.power",
				unit: "%",
				min: 0,
				max: 100,
				read: true,
				write: true,
				def: 100,
			}],
			["power_limit_watt", {
				name: "Power limit (watt)",
				type: "number",
				role: "level.power",
				unit: "W",
				min: 10,
				max: 65535,
				read: true,
				write: true,
				def: inv.ch_max_pwr[0] || 600,
			}],
		];

		for (const [id, common] of controlStates) {
			await this.setObjectNotExistsAsync(`${deviceId}.control.${id}`, {
				type: "state",
				common,
				native: { inverterId: inv.id },
			});
		}
	}

	// ── Polling ───────────────────────────────────────────────────────────────

	private async pollInverters(): Promise<void> {
		if (!this.http) return;

		for (const [id, inv] of this.knownInverters) {
			try {
				const res = await this.http.get<InverterDataResponse>(`/api/inverter/id/${id}`, {
					headers: this.getAuthHeaders(),
				});
				await this.updateInverterStates(inv, res.data);
			} catch (err) {
				this.log.warn(`Failed to poll inverter ${inv.name} (id=${id}): ${(err as Error).message}`);
				const deviceId = this.sanitizeId(inv.name);
				await this.setStateAsync(`${deviceId}.info.reachable`, false, true);
			}
		}
	}

	private async updateInverterStates(inv: InverterConfig, data: InverterDataResponse): Promise<void> {
		const deviceId = this.sanitizeId(inv.name);
		const ch = data.ch;

		if (!ch || ch.length === 0) {
			this.log.warn(`No channel data for inverter ${inv.name}`);
			await this.setStateAsync(`${deviceId}.info.reachable`, false, true);
			return;
		}

		// ── Info states ───────────────────────────────────────────────────
		await this.setStateAsync(`${deviceId}.info.name`, { val: data.name, ack: true });
		await this.setStateAsync(`${deviceId}.info.serial`, { val: data.serial, ack: true });
		await this.setStateAsync(`${deviceId}.info.status`, { val: data.status, ack: true });
		await this.setStateAsync(`${deviceId}.info.version`, { val: data.version || "", ack: true });
		await this.setStateAsync(`${deviceId}.info.alarm_cnt`, { val: data.alarm_cnt, ack: true });
		await this.setStateAsync(`${deviceId}.info.rssi`, { val: data.rssi, ack: true });
		await this.setStateAsync(`${deviceId}.info.last_success`, { val: data.ts_last_success * 1000, ack: true });
		await this.setStateAsync(`${deviceId}.info.max_power`, { val: data.max_pwr, ack: true });
		await this.setStateAsync(`${deviceId}.info.reachable`, { val: data.status >= 1, ack: true });
		await this.setStateAsync(`${deviceId}.info.power_limit_pct`, { val: data.power_limit_read, ack: true });

		// ── AC channel (ch[0]) ────────────────────────────────────────────
		if (ch[0] && ch[0].length > CH0_FIELDS.MaxPower) {
			const ac = ch[0];
			await this.setStateAsync(`${deviceId}.ac.voltage`, { val: this.round(ac[CH0_FIELDS.U_AC], 1), ack: true });
			await this.setStateAsync(`${deviceId}.ac.current`, { val: this.round(ac[CH0_FIELDS.I_AC], 2), ack: true });
			await this.setStateAsync(`${deviceId}.ac.power`, { val: this.round(ac[CH0_FIELDS.P_AC], 1), ack: true });
			await this.setStateAsync(`${deviceId}.ac.frequency`, { val: this.round(ac[CH0_FIELDS.F_AC], 2), ack: true });
			await this.setStateAsync(`${deviceId}.ac.power_factor`, { val: this.round(ac[CH0_FIELDS.PF_AC], 3), ack: true });
			await this.setStateAsync(`${deviceId}.ac.temperature`, { val: this.round(ac[CH0_FIELDS.Temp], 1), ack: true });
			await this.setStateAsync(`${deviceId}.ac.yield_total`, { val: this.round(ac[CH0_FIELDS.YieldTotal], 3), ack: true });
			await this.setStateAsync(`${deviceId}.ac.yield_day`, { val: this.round(ac[CH0_FIELDS.YieldDay], 0), ack: true });
			await this.setStateAsync(`${deviceId}.ac.dc_power`, { val: this.round(ac[CH0_FIELDS.P_DC], 1), ack: true });
			await this.setStateAsync(`${deviceId}.ac.efficiency`, { val: this.round(ac[CH0_FIELDS.Efficiency], 3), ack: true });
			await this.setStateAsync(`${deviceId}.ac.reactive_power`, { val: this.round(ac[CH0_FIELDS.Q_AC], 1), ack: true });
			await this.setStateAsync(`${deviceId}.ac.max_ac_power`, { val: this.round(ac[CH0_FIELDS.MaxPower], 1), ack: true });
		}

		// ── DC channels (ch[1], ch[2], ...) ──────────────────────────────
		const dcChannels = inv.channels || 1;
		for (let chIdx = 1; chIdx <= dcChannels; chIdx++) {
			if (!ch[chIdx] || ch[chIdx].length <= DC_FIELDS.MaxPower) continue;
			const dc = ch[chIdx];
			await this.setStateAsync(`${deviceId}.dc.ch${chIdx}.voltage`, { val: this.round(dc[DC_FIELDS.U_DC], 1), ack: true });
			await this.setStateAsync(`${deviceId}.dc.ch${chIdx}.current`, { val: this.round(dc[DC_FIELDS.I_DC], 2), ack: true });
			await this.setStateAsync(`${deviceId}.dc.ch${chIdx}.power`, { val: this.round(dc[DC_FIELDS.P_DC], 1), ack: true });
			await this.setStateAsync(`${deviceId}.dc.ch${chIdx}.yield_day`, { val: this.round(dc[DC_FIELDS.YieldDay], 0), ack: true });
			await this.setStateAsync(`${deviceId}.dc.ch${chIdx}.yield_total`, { val: this.round(dc[DC_FIELDS.YieldTotal], 3), ack: true });
			await this.setStateAsync(`${deviceId}.dc.ch${chIdx}.irradiation`, { val: this.round(dc[DC_FIELDS.Irradiation], 3), ack: true });
			await this.setStateAsync(`${deviceId}.dc.ch${chIdx}.max_power`, { val: this.round(dc[DC_FIELDS.MaxPower], 1), ack: true });
		}

		// Update control state read-back for power limit
		await this.setStateAsync(`${deviceId}.control.power_limit_percent`, { val: data.power_limit_read, ack: true });
	}

	// ── Control ───────────────────────────────────────────────────────────────

	private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
		if (!state || state.ack) return; // only handle commands (ack=false)

		this.log.debug(`Command received: ${id} = ${state.val}`);

		// Find which inverter this belongs to
		// id format: ahoydtu.0.{deviceId}.control.{cmd}
		const parts = id.split(".");
		// parts: ["ahoydtu", "0", deviceId, "control", cmdName]
		if (parts.length < 5 || parts[3] !== "control") return;

		const deviceId = parts[2];
		const cmd = parts[4];

		// Find the inverter id from knownInverters
		let inverterId: number | undefined;
		for (const [id, inv] of this.knownInverters) {
			if (this.sanitizeId(inv.name) === deviceId) {
				inverterId = id;
				break;
			}
		}

		if (inverterId === undefined) {
			this.log.warn(`Control command for unknown device: ${deviceId}`);
			return;
		}

		await this.sendControl(inverterId, deviceId, cmd, state.val);
	}

	private async sendControl(
		inverterId: number,
		deviceId: string,
		cmd: string,
		val: ioBroker.StateValue,
	): Promise<void> {
		if (!this.http) return;

		let body: Record<string, unknown>;

		switch (cmd) {
			case "power":
				body = { id: inverterId, cmd: "power", val: val ? 1 : 0 };
				break;
			case "restart":
				if (!val) return; // only trigger on true
				body = { id: inverterId, cmd: "restart" };
				break;
			case "power_limit_percent": {
				const pct = Number(val);
				if (pct < 2 || pct > 100) {
					this.log.warn(`power_limit_percent must be between 2 and 100 (got ${pct})`);
					return;
				}
				body = { id: inverterId, cmd: "limit_nonpersistent_relative", val: pct };
				break;
			}
			case "power_limit_watt":
				body = { id: inverterId, cmd: "limit_nonpersistent_absolute", val: Number(val) };
				break;
			default:
				this.log.warn(`Unknown control command: ${cmd}`);
				return;
		}

		// Add auth token if available
		if (this.authToken) {
			body.token = this.authToken;
		}

		try {
			const res = await this.http.post<{ success: boolean; error?: string }>("/api/ctrl", body);
			if (res.data.success) {
				this.log.info(`Control command ${cmd}=${val} sent to inverter ${inverterId}`);
				// Acknowledge the state
				await this.setStateAsync(`${deviceId}.control.${cmd}`, { val, ack: true });
			} else {
				this.log.warn(`Control command failed: ${res.data.error || "unknown"}`);
				// Re-authenticate if token expired
				if (res.data.error === "ERR_PROTECTED") {
					await this.authenticate();
				}
			}
		} catch (err) {
			this.log.error(`Failed to send control command ${cmd}: ${(err as Error).message}`);
		}
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	private round(val: number | undefined, decimals: number): number {
		if (val === undefined || val === null || isNaN(val)) return 0;
		const factor = Math.pow(10, decimals);
		return Math.round(val * factor) / factor;
	}
}

// ─── Entry point ──────────────────────────────────────────────────────────────

if (require.main !== module) {
	// Export the constructor in compact mode
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Ahoydtu(options);
} else {
	// otherwise start the instance directly
	(() => new Ahoydtu())();
}
