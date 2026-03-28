"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var deviceManagement_exports = {};
__export(deviceManagement_exports, {
  AhoydtuDeviceManagement: () => AhoydtuDeviceManagement
});
module.exports = __toCommonJS(deviceManagement_exports);
var import_dm_utils = require("@iobroker/dm-utils");
class AhoydtuDeviceManagement extends import_dm_utils.DeviceManagement {
  /**
   * Returns instance-level info: api version and instance actions.
   */
  getInstanceInfo() {
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
            return { refresh: true };
          }
        }
      ]
    };
  }
  /**
   * Loads all devices (inverters) into the context.
   * Called when the user opens the instance in the Device Manager tab.
   */
  loadDevices(context) {
    const inverters = this.adapter.getKnownInverters();
    context.setTotalDevices(inverters.size);
    for (const [, inv] of inverters) {
      const deviceId = this.adapter.sanitizeDeviceId(inv.name);
      const prefix = `${this.adapter.namespace}.${deviceId}`;
      const deviceInfo = {
        id: deviceId,
        name: inv.name,
        identifier: inv.serial,
        icon: "socket",
        status: {
          connection: {
            stateId: `${prefix}.info.reachable`,
            mapping: { true: "connected", false: "disconnected" }
          },
          rssi: { stateId: `${prefix}.info.rssi` }
        },
        hasDetails: false,
        actions: [
          {
            id: "power_on",
            icon: "play",
            description: { en: "Turn on", de: "Einschalten" },
            handler: async (_deviceId, context2) => {
              const confirmed = await context2.showConfirmation({
                en: `Turn on inverter "${inv.name}"?`,
                de: `Wechselrichter "${inv.name}" einschalten?`
              });
              if (!confirmed) return { refresh: "none" };
              await this.adapter.sendInverterControl(inv.id, deviceId, "power", true);
              return { refresh: "devices" };
            }
          },
          {
            id: "power_off",
            icon: "stop",
            description: { en: "Turn off", de: "Ausschalten" },
            handler: async (_deviceId, context2) => {
              const confirmed = await context2.showConfirmation({
                en: `Turn off inverter "${inv.name}"?`,
                de: `Wechselrichter "${inv.name}" ausschalten?`
              });
              if (!confirmed) return { refresh: "none" };
              await this.adapter.sendInverterControl(inv.id, deviceId, "power", false);
              return { refresh: "devices" };
            }
          },
          {
            id: "restart",
            icon: "refresh",
            description: { en: "Restart inverter MCU", de: "Wechselrichter-MCU neu starten" },
            handler: async (_deviceId, context2) => {
              const confirmed = await context2.showConfirmation({
                en: `Restart inverter "${inv.name}"? This will briefly interrupt power output.`,
                de: `Wechselrichter "${inv.name}" neu starten? Die Einspeisung wird kurz unterbrochen.`
              });
              if (!confirmed) return { refresh: "none" };
              await this.adapter.sendInverterControl(inv.id, deviceId, "restart", true);
              return { refresh: "devices" };
            }
          },
          {
            id: "set_limit",
            icon: "dimmer",
            description: { en: "Set power limit", de: "Leistungsbegrenzung setzen" },
            handler: async (_deviceId, context2) => {
              const result = await context2.showForm(
                {
                  type: "panel",
                  items: {
                    limit_type: {
                      type: "select",
                      label: { en: "Limit type", de: "Begrenzungsart" },
                      options: [
                        { value: "percent", label: { en: "Percent (%)", de: "Prozent (%)" } },
                        { value: "watt", label: { en: "Absolute (W)", de: "Absolut (W)" } }
                      ],
                      default: "percent"
                    },
                    limit_value: {
                      type: "number",
                      label: { en: "Value", de: "Wert" },
                      min: 2,
                      max: 65535,
                      default: 100
                    }
                  }
                },
                {
                  title: { en: "Set power limit", de: "Leistungsbegrenzung" },
                  data: { limit_type: "percent", limit_value: 100 }
                }
              );
              if (!result) return { refresh: "none" };
              const cmd = result.limit_type === "percent" ? "power_limit_percent" : "power_limit_watt";
              await this.adapter.sendInverterControl(inv.id, deviceId, cmd, result.limit_value);
              return { refresh: "devices" };
            }
          }
        ],
        controls: [
          {
            id: "power",
            type: "switch",
            label: { en: "Power", de: "Einspeisung" },
            stateId: `${prefix}.control.power`
          }
        ]
      };
      context.addDevice(deviceInfo);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AhoydtuDeviceManagement
});
//# sourceMappingURL=deviceManagement.js.map
