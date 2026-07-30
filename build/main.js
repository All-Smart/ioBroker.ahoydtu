"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_axios = __toESM(require("axios"));
var import_deviceManagement = require("./lib/deviceManagement");
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
  MaxTemp: 12
};
const DC_FIELDS = {
  U_DC: 0,
  I_DC: 1,
  P_DC: 2,
  YieldDay: 3,
  YieldTotal: 4,
  Irradiation: 5,
  MaxPower: 6
};
const Q_NO_CONNECTION = 2;
const AC_LIVE_STATES = [
  "voltage",
  "current",
  "power",
  "reactive_power",
  "frequency",
  "power_factor",
  "efficiency",
  "dc_power"
];
const AC_KEEP_STATES = ["yield_day", "yield_total", "max_ac_power"];
const DC_LIVE_STATES = ["voltage", "current", "power", "irradiation"];
const DC_KEEP_STATES = ["yield_day", "yield_total", "max_power"];
class Ahoydtu extends utils.Adapter {
  http = null;
  authToken = null;
  pollTimer = null;
  midnightTimer;
  knownInverters = /* @__PURE__ */ new Map();
  liveData = null;
  /** DTU clock minus local clock in seconds - used to age ts_last_success */
  dtuTimeOffset = 0;
  /** Last known online state per inverter id - offline reset runs on the edge only */
  onlineState = /* @__PURE__ */ new Map();
  deviceManagement;
  constructor(options = {}) {
    super({
      ...options,
      name: "ahoydtu"
    });
    this.deviceManagement = new import_deviceManagement.AhoydtuDeviceManagement(this);
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  // ── Public helpers for DeviceManagement ───────────────────────────────────
  /** Returns all known inverters (used by DeviceManagement) */
  getKnownInverters() {
    return this.knownInverters;
  }
  /** Returns an InverterConfig by sanitized device ID */
  getInverterByDeviceId(deviceId) {
    for (const [, inv] of this.knownInverters) {
      if (this.sanitizeId(inv.name) === deviceId) {
        return inv;
      }
    }
    return void 0;
  }
  /** Sanitizes a name to a valid ioBroker object ID segment (public) */
  sanitizeDeviceId(name) {
    return this.sanitizeId(name);
  }
  /** Re-discovers inverters from DTU (called by DeviceManagement refresh action) */
  async rediscoverInverters() {
    this.knownInverters.clear();
    this.onlineState.clear();
    await this.discoverInverters();
  }
  /** Sends a control command to an inverter (public for DeviceManagement) */
  async sendInverterControl(inverterId, deviceId, cmd, val) {
    await this.sendControl(inverterId, deviceId, cmd, val);
  }
  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async onReady() {
    if (!this.config.host || this.config.host.trim() === "") {
      this.log.error("No host configured - please set the IP/hostname of your AhoyDTU");
      return;
    }
    const port = this.config.port || 80;
    const interval = Math.max(5, this.config.pollInterval || 15);
    this.log.info(`Connecting to AhoyDTU at ${this.config.host}:${port}, poll interval: ${interval}s`);
    this.http = import_axios.default.create({
      baseURL: `http://${this.config.host.trim()}:${port}`,
      timeout: 1e4,
      headers: { "Content-Type": "application/json" }
    });
    await this.setObjectNotExistsAsync("info", {
      type: "channel",
      common: { name: "Adapter information" },
      native: {}
    });
    await this.setObjectNotExistsAsync("info.connection", {
      type: "state",
      common: {
        name: "Connection status",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false
      },
      native: {}
    });
    this.setState("info.connection", false, true);
    if (this.config.password && this.config.password.trim() !== "") {
      await this.authenticate();
    }
    try {
      await this.discoverInverters();
      await this.pollInverters();
      this.setState("info.connection", true, true);
    } catch (err) {
      this.log.error(`Initial connection failed: ${err.message}`);
      this.setState("info.connection", false, true);
      await this.setAllInvertersOffline();
    }
    this.pollTimer = setInterval(async () => {
      try {
        await this.pollInverters();
        this.setState("info.connection", true, true);
      } catch (err) {
        this.log.warn(`Poll failed: ${err.message}`);
        this.setState("info.connection", false, true);
        await this.setAllInvertersOffline();
      }
    }, interval * 1e3);
    this.scheduleMidnightReset();
    this.subscribeStates("*.control.*");
  }
  onUnload(callback) {
    try {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      if (this.midnightTimer) {
        this.clearTimeout(this.midnightTimer);
        this.midnightTimer = void 0;
      }
      this.setState("info.connection", false, true);
      callback();
    } catch (e) {
      this.log.error(`Error during unload: ${e.message}`);
      callback();
    }
  }
  // ── Auth ───────────────────────────────────────────────────────────────────
  async authenticate() {
    if (!this.http) return;
    try {
      const res = await this.http.post("/api/auth", {
        auth: this.config.password
      });
      if (res.data.success && res.data.token) {
        this.authToken = res.data.token;
        this.log.debug("Authentication successful");
      } else {
        this.log.warn(`Authentication failed: ${res.data.error || "unknown error"}`);
      }
    } catch (err) {
      this.log.warn(`Authentication request failed: ${err.message}`);
    }
  }
  getAuthHeaders() {
    if (this.authToken) {
      return { token: this.authToken };
    }
    return {};
  }
  // ── Discovery ─────────────────────────────────────────────────────────────
  /** Fetches /api/live and refreshes the DTU clock offset */
  async fetchLiveData() {
    if (!this.http) return;
    const res = await this.http.get("/api/live", {
      headers: this.getAuthHeaders()
    });
    this.liveData = res.data;
    this.dtuTimeOffset = res.data.generic.ts_now - Math.floor(Date.now() / 1e3);
  }
  async discoverInverters() {
    var _a;
    if (!this.http) return;
    await this.fetchLiveData();
    this.log.debug(`AhoyDTU firmware: ${(_a = this.liveData) == null ? void 0 : _a.generic.version}`);
    const listRes = await this.http.get("/api/inverter/list", {
      headers: this.getAuthHeaders()
    });
    const inverters = listRes.data.inverter.filter((inv) => inv.enabled);
    this.log.info(`Found ${inverters.length} enabled inverter(s)`);
    for (const inv of inverters) {
      this.knownInverters.set(inv.id, inv);
      await this.createInverterObjects(inv);
    }
  }
  // ── Object creation ───────────────────────────────────────────────────────
  sanitizeId(name) {
    return name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  }
  async createInverterObjects(inv) {
    const deviceId = this.sanitizeId(inv.name);
    await this.setObjectNotExistsAsync(deviceId, {
      type: "device",
      common: {
        name: inv.name,
        icon: "ahoydtu.png"
      },
      native: {
        id: inv.id,
        serial: inv.serial
      }
    });
    await this.setObjectNotExistsAsync(`${deviceId}.info`, {
      type: "channel",
      common: { name: "Info" },
      native: {}
    });
    const infoStates = [
      ["name", { name: "Inverter name", type: "string", role: "info.name", read: true, write: false, def: inv.name }],
      ["serial", { name: "Serial number", type: "string", role: "info.serial", read: true, write: false, def: inv.serial }],
      ["status", {
        name: "Status",
        type: "number",
        role: "indicator",
        read: true,
        write: false,
        states: { 0: "offline", 1: "partial", 2: "online", 3: "was producing", 4: "was available" },
        def: 0
      }],
      ["version", { name: "Firmware version", type: "string", role: "info.firmware", read: true, write: false, def: "" }],
      ["alarm_cnt", { name: "Alarm count", type: "number", role: "value", read: true, write: false, def: 0 }],
      ["rssi", { name: "RSSI signal strength", type: "number", role: "value", unit: "dBm", read: true, write: false, def: 0 }],
      ["last_success", { name: "Last successful contact", type: "number", role: "date.timestamp", read: true, write: false, def: 0 }],
      ["max_power", { name: "Max inverter power", type: "number", role: "value.power.max", unit: "W", read: true, write: false, def: inv.ch_max_pwr[0] || 0 }],
      ["reachable", { name: "Reachable", type: "boolean", role: "indicator.reachable", read: true, write: false, def: false }],
      ["power_limit_pct", { name: "Current power limit", type: "number", role: "value", unit: "%", read: true, write: false, def: 0 }]
    ];
    for (const [id, common] of infoStates) {
      await this.setObjectNotExistsAsync(`${deviceId}.info.${id}`, {
        type: "state",
        common,
        native: {}
      });
    }
    await this.setObjectNotExistsAsync(`${deviceId}.ac`, {
      type: "channel",
      common: { name: "AC output" },
      native: {}
    });
    const acStates = [
      ["voltage", { name: "AC voltage", type: "number", role: "value.voltage", unit: "V", read: true, write: false, def: 0 }],
      ["current", { name: "AC current", type: "number", role: "value.current", unit: "A", read: true, write: false, def: 0 }],
      ["power", { name: "AC power", type: "number", role: "value.power", unit: "W", read: true, write: false, def: 0 }],
      ["reactive_power", { name: "AC reactive power", type: "number", role: "value.power", unit: "var", read: true, write: false, def: 0 }],
      ["frequency", { name: "AC frequency", type: "number", role: "value.frequency", unit: "Hz", read: true, write: false, def: 0 }],
      ["power_factor", { name: "AC power factor", type: "number", role: "value.factor", unit: "%", read: true, write: false, def: 0 }],
      ["temperature", { name: "Inverter temperature", type: "number", role: "value.temperature", unit: "\xB0C", read: true, write: false, def: 0 }],
      ["yield_day", { name: "Daily yield", type: "number", role: "value.energy", unit: "Wh", read: true, write: false, def: 0 }],
      ["yield_total", { name: "Total yield", type: "number", role: "value.energy", unit: "kWh", read: true, write: false, def: 0 }],
      ["dc_power", { name: "DC total power", type: "number", role: "value.power", unit: "W", read: true, write: false, def: 0 }],
      ["efficiency", { name: "Efficiency", type: "number", role: "value.efficiency", unit: "%", read: true, write: false, def: 0 }],
      ["max_ac_power", { name: "Max AC power", type: "number", role: "value.power.max", unit: "W", read: true, write: false, def: 0 }]
    ];
    for (const [id, common] of acStates) {
      await this.setObjectNotExistsAsync(`${deviceId}.ac.${id}`, {
        type: "state",
        common,
        native: {}
      });
    }
    const dcChannels = inv.channels || 1;
    for (let ch = 1; ch <= dcChannels; ch++) {
      const chName = inv.ch_name[ch - 1] || `Channel ${ch}`;
      await this.setObjectNotExistsAsync(`${deviceId}.dc`, {
        type: "channel",
        common: { name: "DC inputs" },
        native: {}
      });
      await this.setObjectNotExistsAsync(`${deviceId}.dc.ch${ch}`, {
        type: "channel",
        common: { name: chName || `DC Channel ${ch}` },
        native: { channel: ch }
      });
      const dcStates = [
        ["voltage", { name: `DC voltage CH${ch}`, type: "number", role: "value.voltage", unit: "V", read: true, write: false, def: 0 }],
        ["current", { name: `DC current CH${ch}`, type: "number", role: "value.current", unit: "A", read: true, write: false, def: 0 }],
        ["power", { name: `DC power CH${ch}`, type: "number", role: "value.power", unit: "W", read: true, write: false, def: 0 }],
        ["yield_day", { name: `Daily yield CH${ch}`, type: "number", role: "value.energy", unit: "Wh", read: true, write: false, def: 0 }],
        ["yield_total", { name: `Total yield CH${ch}`, type: "number", role: "value.energy", unit: "kWh", read: true, write: false, def: 0 }],
        ["irradiation", { name: `Irradiation CH${ch}`, type: "number", role: "value.irradiation", unit: "%", read: true, write: false, def: 0 }],
        ["max_power", { name: `Max power CH${ch}`, type: "number", role: "value.power.max", unit: "W", read: true, write: false, def: inv.ch_max_pwr[ch] || 0 }]
      ];
      for (const [id, common] of dcStates) {
        await this.setObjectNotExistsAsync(`${deviceId}.dc.ch${ch}.${id}`, {
          type: "state",
          common,
          native: {}
        });
      }
    }
    await this.setObjectNotExistsAsync(`${deviceId}.control`, {
      type: "channel",
      common: { name: "Control" },
      native: {}
    });
    const controlStates = [
      ["power", {
        name: "Power on/off",
        type: "boolean",
        role: "switch.power",
        read: true,
        write: true,
        def: true
      }],
      ["restart", {
        name: "Restart inverter",
        type: "boolean",
        role: "button",
        read: false,
        write: true,
        def: false
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
        def: 100
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
        def: inv.ch_max_pwr[0] || 600
      }]
    ];
    for (const [id, common] of controlStates) {
      await this.setObjectNotExistsAsync(`${deviceId}.control.${id}`, {
        type: "state",
        common,
        native: { inverterId: inv.id }
      });
    }
  }
  // ── Polling ───────────────────────────────────────────────────────────────
  async pollInverters() {
    if (!this.http) return;
    await this.fetchLiveData();
    for (const [id, inv] of this.knownInverters) {
      try {
        const res = await this.http.get(`/api/inverter/id/${id}`, {
          headers: this.getAuthHeaders()
        });
        await this.updateInverterStates(inv, res.data);
      } catch (err) {
        this.log.warn(`Failed to poll inverter ${inv.name} (id=${id}): ${err.message}`);
        await this.setInverterOffline(inv);
      }
    }
  }
  /** Current DTU time in seconds (local clock corrected by the DTU offset) */
  dtuNow() {
    return Math.floor(Date.now() / 1e3) + this.dtuTimeOffset;
  }
  /**
   * The DTU keeps serving the last received measurement set forever, so the payload
   * alone never tells us whether an inverter is still there. Two independent checks:
   * the Ahoy status enum (0=OFF, 1=STARTING, 2=PRODUCING, 3=WAS_PRODUCING, 4=WAS_ON -
   * 3 and 4 are explicitly "not reachable anymore") and the age of ts_last_success.
   */
  isInverterOnline(data) {
    const statusOk = data.status === 1 || data.status === 2;
    const maxAge = Math.max(3 * (this.config.pollInterval || 15), 120);
    const fresh = data.ts_last_success > 0 && this.dtuNow() - data.ts_last_success < maxAge;
    return statusOk && fresh;
  }
  async updateInverterStates(inv, data) {
    const deviceId = this.sanitizeId(inv.name);
    const ch = data.ch;
    await this.setStateAsync(`${deviceId}.info.name`, { val: data.name, ack: true });
    await this.setStateAsync(`${deviceId}.info.serial`, { val: data.serial, ack: true });
    await this.setStateAsync(`${deviceId}.info.status`, { val: data.status, ack: true });
    await this.setStateAsync(`${deviceId}.info.version`, { val: data.version || "", ack: true });
    await this.setStateAsync(`${deviceId}.info.alarm_cnt`, { val: data.alarm_cnt, ack: true });
    await this.setStateAsync(`${deviceId}.info.rssi`, { val: data.rssi, ack: true });
    await this.setStateAsync(`${deviceId}.info.last_success`, { val: data.ts_last_success * 1e3, ack: true });
    await this.setStateAsync(`${deviceId}.info.max_power`, { val: data.max_pwr, ack: true });
    await this.setStateAsync(`${deviceId}.info.power_limit_pct`, { val: data.power_limit_read, ack: true });
    const online = this.isInverterOnline(data);
    if (!online || !ch || ch.length === 0) {
      if (online) {
        this.log.warn(`No channel data for inverter ${inv.name}`);
      }
      await this.setInverterOffline(inv);
      return;
    }
    await this.setStateAsync(`${deviceId}.info.reachable`, { val: true, ack: true });
    this.onlineState.set(inv.id, true);
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
    await this.setStateAsync(`${deviceId}.control.power_limit_percent`, { val: data.power_limit_read, ack: true });
  }
  // ── Offline handling ──────────────────────────────────────────────────────
  /** Marks one inverter unreachable; live values are reset on the online→offline edge only */
  async setInverterOffline(inv) {
    const deviceId = this.sanitizeId(inv.name);
    await this.setStateAsync(`${deviceId}.info.reachable`, { val: false, ack: true });
    if (this.onlineState.get(inv.id) === false) return;
    this.onlineState.set(inv.id, false);
    await this.clearLiveValues(inv);
  }
  async setAllInvertersOffline() {
    for (const [, inv] of this.knownInverters) {
      await this.setInverterOffline(inv);
    }
  }
  /**
   * Resets momentary readings to 0 and flags every value of the inverter as stale.
   * Counters keep their last value - zeroing them would corrupt history and statistics.
   */
  async clearLiveValues(inv) {
    const deviceId = this.sanitizeId(inv.name);
    this.log.debug(`Inverter ${inv.name} is offline - resetting live values`);
    for (const id of AC_LIVE_STATES) {
      await this.setStateAsync(`${deviceId}.ac.${id}`, { val: 0, ack: true, q: Q_NO_CONNECTION });
    }
    await this.setStateAsync(`${deviceId}.ac.temperature`, { val: null, ack: true, q: Q_NO_CONNECTION });
    for (const id of AC_KEEP_STATES) {
      await this.markStale(`${deviceId}.ac.${id}`);
    }
    const dcChannels = inv.channels || 1;
    for (let ch = 1; ch <= dcChannels; ch++) {
      for (const id of DC_LIVE_STATES) {
        await this.setStateAsync(`${deviceId}.dc.ch${ch}.${id}`, { val: 0, ack: true, q: Q_NO_CONNECTION });
      }
      for (const id of DC_KEEP_STATES) {
        await this.markStale(`${deviceId}.dc.ch${ch}.${id}`);
      }
    }
  }
  /** Keeps the last value but flags it with the "no connection" quality code */
  async markStale(id) {
    const state = await this.getStateAsync(id);
    if (!state) return;
    await this.setStateAsync(id, { val: state.val, ack: true, q: Q_NO_CONNECTION });
  }
  // ── Midnight reset ────────────────────────────────────────────────────────
  /** Schedules the next daily yield reset at local midnight (re-arms itself, DST-safe) */
  scheduleMidnightReset() {
    const now = /* @__PURE__ */ new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 10);
    this.midnightTimer = this.setTimeout(async () => {
      this.midnightTimer = void 0;
      await this.resetDailyYield();
      this.scheduleMidnightReset();
    }, next.getTime() - now.getTime());
  }
  /**
   * The DTU only zeroes yield_day once the inverter reports back, so an inverter that
   * stays offline over night keeps yesterday's value until sunrise. Reset it locally.
   * Total counters are left untouched.
   */
  async resetDailyYield() {
    this.log.debug("Midnight - resetting daily yield counters");
    for (const [, inv] of this.knownInverters) {
      const deviceId = this.sanitizeId(inv.name);
      const q = this.onlineState.get(inv.id) === false ? Q_NO_CONNECTION : 0;
      await this.setStateAsync(`${deviceId}.ac.yield_day`, { val: 0, ack: true, q });
      const dcChannels = inv.channels || 1;
      for (let ch = 1; ch <= dcChannels; ch++) {
        await this.setStateAsync(`${deviceId}.dc.ch${ch}.yield_day`, { val: 0, ack: true, q });
      }
    }
  }
  // ── Control ───────────────────────────────────────────────────────────────
  async onStateChange(id, state) {
    if (!state || state.ack) return;
    this.log.debug(`Command received: ${id} = ${state.val}`);
    const parts = id.split(".");
    if (parts.length < 5 || parts[3] !== "control") return;
    const deviceId = parts[2];
    const cmd = parts[4];
    let inverterId;
    for (const [id2, inv] of this.knownInverters) {
      if (this.sanitizeId(inv.name) === deviceId) {
        inverterId = id2;
        break;
      }
    }
    if (inverterId === void 0) {
      this.log.warn(`Control command for unknown device: ${deviceId}`);
      return;
    }
    await this.sendControl(inverterId, deviceId, cmd, state.val);
  }
  async sendControl(inverterId, deviceId, cmd, val) {
    if (!this.http) return;
    let body;
    switch (cmd) {
      case "power":
        body = { id: inverterId, cmd: "power", val: val ? 1 : 0 };
        break;
      case "restart":
        if (!val) return;
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
    if (this.authToken) {
      body.token = this.authToken;
    }
    try {
      const res = await this.http.post("/api/ctrl", body);
      if (res.data.success) {
        this.log.info(`Control command ${cmd}=${val} sent to inverter ${inverterId}`);
        await this.setStateAsync(`${deviceId}.control.${cmd}`, { val, ack: true });
      } else {
        this.log.warn(`Control command failed: ${res.data.error || "unknown"}`);
        if (res.data.error === "ERR_PROTECTED") {
          await this.authenticate();
        }
      }
    } catch (err) {
      this.log.error(`Failed to send control command ${cmd}: ${err.message}`);
    }
  }
  // ── Helpers ───────────────────────────────────────────────────────────────
  round(val, decimals) {
    if (val === void 0 || val === null || isNaN(val)) return 0;
    const factor = Math.pow(10, decimals);
    return Math.round(val * factor) / factor;
  }
}
if (require.main !== module) {
  module.exports = (options) => new Ahoydtu(options);
} else {
  (() => new Ahoydtu())();
}
//# sourceMappingURL=main.js.map
