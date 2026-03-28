import { DeviceManagement, type DeviceLoadContext } from "@iobroker/dm-utils";
import type { DeviceInfo, InstanceDetails } from "@iobroker/dm-utils";
import type { InverterConfig, IAhoydtuAdapter } from "./types";

export type { IAhoydtuAdapter };

// ─── AhoyDTU Device Management (dm-utils v3) ─────────────────────────────────

export class AhoydtuDeviceManagement extends DeviceManagement<IAhoydtuAdapter> {

	/**
	 * Returns instance-level info: api version and instance actions.
	 */
	protected getInstanceInfo(): InstanceDetails {
		return {
			apiVersion: "v3",
			actions: [
				{
					id: "refresh",
					icon: "refresh",
					title: { en: "Refresh inverter list", de: "Wechselrichterliste aktualisieren" },
					description: { en: "Re-discover all inverters from AhoyDTU", de: "Alle Wechselrichter neu einlesen" },
					handler: async (context) => {
						const progress = await context.openProgress("Refreshing...", { indeterminate: true });
						try {
							await this.adapter.rediscoverInverters();
						} finally {
							await progress.close();
						}
						// InstanceRefreshResponse = { refresh: boolean }
						return { refresh: true };
					},
				},
			],
		};
	}

	/**
	 * Loads all devices (inverters) into the context.
	 * Called when the user opens the instance in the Device Manager tab.
	 */
	protected loadDevices(context: DeviceLoadContext<string>): void {
		const inverters = this.adapter.getKnownInverters();
		context.setTotalDevices(inverters.size);

		for (const [, inv] of inverters) {
			const deviceId = this.adapter.sanitizeDeviceId(inv.name);
			const prefix = `${this.adapter.namespace}.${deviceId}`;

			const deviceInfo: DeviceInfo<string> = {
				id: deviceId,
				name: inv.name,
				identifier: inv.serial,
				icon: "socket",
				status: {
					connection: {
						stateId: `${prefix}.info.reachable`,
						mapping: { true: "connected", false: "disconnected" },
					},
					rssi: { stateId: `${prefix}.info.rssi` },
				},
				hasDetails: false,
				actions: [
					{
						id: "power_on",
						icon: "play",
						description: { en: "Turn on", de: "Einschalten" },
						handler: async (_deviceId, context) => {
							const confirmed = await context.showConfirmation({
								en: `Turn on inverter "${inv.name}"?`,
								de: `Wechselrichter "${inv.name}" einschalten?`,
							});
							if (!confirmed) return { refresh: "none" as const };
							await this.adapter.sendInverterControl(inv.id, deviceId, "power", true);
							return { refresh: "devices" as const };
						},
					},
					{
						id: "power_off",
						icon: "stop",
						description: { en: "Turn off", de: "Ausschalten" },
						handler: async (_deviceId, context) => {
							const confirmed = await context.showConfirmation({
								en: `Turn off inverter "${inv.name}"?`,
								de: `Wechselrichter "${inv.name}" ausschalten?`,
							});
							if (!confirmed) return { refresh: "none" as const };
							await this.adapter.sendInverterControl(inv.id, deviceId, "power", false);
							return { refresh: "devices" as const };
						},
					},
					{
						id: "restart",
						icon: "refresh",
						description: { en: "Restart inverter MCU", de: "Wechselrichter-MCU neu starten" },
						handler: async (_deviceId, context) => {
							const confirmed = await context.showConfirmation({
								en: `Restart inverter "${inv.name}"? This will briefly interrupt power output.`,
								de: `Wechselrichter "${inv.name}" neu starten? Die Einspeisung wird kurz unterbrochen.`,
							});
							if (!confirmed) return { refresh: "none" as const };
							await this.adapter.sendInverterControl(inv.id, deviceId, "restart", true);
							return { refresh: "devices" as const };
						},
					},
					{
						id: "set_limit",
						icon: "dimmer",
						description: { en: "Set power limit", de: "Leistungsbegrenzung setzen" },
						handler: async (_deviceId, context) => {
							const result = await context.showForm(
								{
									type: "panel",
									items: {
										limit_type: {
											type: "select",
											label: { en: "Limit type", de: "Begrenzungsart" },
											options: [
												{ value: "percent", label: { en: "Percent (%)", de: "Prozent (%)" } },
												{ value: "watt", label: { en: "Absolute (W)", de: "Absolut (W)" } },
											],
											default: "percent",
										},
										limit_value: {
											type: "number",
											label: { en: "Value", de: "Wert" },
											min: 2,
											max: 65535,
											default: 100,
										},
									},
								},
								{
									title: { en: "Set power limit", de: "Leistungsbegrenzung" },
									data: { limit_type: "percent", limit_value: 100 },
								},
							);
							if (!result) return { refresh: "none" as const };
							const cmd = result.limit_type === "percent" ? "power_limit_percent" : "power_limit_watt";
							await this.adapter.sendInverterControl(inv.id, deviceId, cmd, result.limit_value);
							return { refresh: "devices" as const };
						},
					},
				],

			};

			context.addDevice(deviceInfo);
		}
	}

}

