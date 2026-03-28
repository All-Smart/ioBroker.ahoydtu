# ioBroker.ahoydtu

[![NPM version](https://img.shields.io/npm/v/iobroker.ahoydtu.svg)](https://www.npmjs.com/package/iobroker.ahoydtu)
[![Downloads](https://img.shields.io/npm/dm/iobroker.ahoydtu.svg)](https://www.npmjs.com/package/iobroker.ahoydtu)
![Number of Installations](https://iobroker.live/badges/ahoydtu-installed.svg)
![Test and Release](https://github.com/Skeletor-ai/ioBroker.ahoydtu/workflows/Test%20and%20Release/badge.svg)

## ioBroker adapter for AhoyDTU

Connects ioBroker to an [AhoyDTU](https://ahoydtu.de/) Hoymiles inverter gateway via **REST API only** (no MQTT).

> MQTT is intentionally not used, as it can cause the AhoyDTU to freeze. The REST API is stable and does not have this problem.

## Features

- Automatic discovery of all configured inverters
- Per-inverter AC channel: voltage, current, power, frequency, power factor, temperature, daily & total yield, efficiency, reactive power
- Per-inverter DC channels (up to 4): voltage, current, power, daily & total yield, irradiation
- Control: power on/off, restart, power limit (% or W)
- Configurable poll interval (default: 15 seconds, min: 5s)
- Authentication support for password-protected AhoyDTU instances
- Connection indicator with automatic offline detection

## Supported Inverters

All Hoymiles inverters supported by AhoyDTU (HM-300 through HM-1500, MI series, TSOL series), firmware **0.7.26+** (uses `/api/inverter/id/{id}` endpoint).

## Installation

Install via ioBroker Admin as usual.

## Configuration

| Field | Description | Default |
|-------|-------------|---------|
| Host / IP | IP address or hostname of your AhoyDTU | 192.168.0.156 |
| Port | HTTP port | 80 |
| Poll interval | How often to fetch data (seconds) | 15 |
| Password | Optional: if AhoyDTU is password-protected | - |

## Data Points

### `{inverter}.info.*`
| ID | Role | Unit | Description |
|----|------|------|-------------|
| name | info.name | - | Inverter name |
| serial | info.serial | - | Serial number |
| status | indicator | - | 0=offline, 1=partial, 2=online |
| version | info.firmware | - | Firmware version |
| alarm_cnt | value | - | Alarm counter |
| rssi | value | dBm | WiFi signal strength |
| last_success | date.timestamp | ms | Last successful contact |
| max_power | value.power.max | W | Maximum inverter power |
| reachable | indicator.reachable | - | Is inverter reachable |
| power_limit_pct | value | % | Current power limit readback |

### `{inverter}.ac.*`
| ID | Role | Unit | Description |
|----|------|------|-------------|
| voltage | value.voltage | V | AC voltage |
| current | value.current | A | AC current |
| power | value.power | W | AC active power |
| reactive_power | value.power | var | AC reactive power |
| frequency | value.frequency | Hz | Grid frequency |
| power_factor | value.factor | % | Power factor |
| temperature | value.temperature | °C | Inverter temperature |
| yield_day | value.energy | Wh | Energy today |
| yield_total | value.energy | kWh | Total energy since reset |
| dc_power | value.power | W | Total DC input power |
| efficiency | value.efficiency | % | Conversion efficiency |
| max_ac_power | value.power.max | W | Peak AC power |

### `{inverter}.dc.ch{N}.*` (N = 1..4)
| ID | Role | Unit | Description |
|----|------|------|-------------|
| voltage | value.voltage | V | DC string voltage |
| current | value.current | A | DC string current |
| power | value.power | W | DC string power |
| yield_day | value.energy | Wh | Energy today for this string |
| yield_total | value.energy | kWh | Total energy for this string |
| irradiation | value.irradiation | % | DC power / rated max power |
| max_power | value.power.max | W | Peak DC power for this string |

### `{inverter}.control.*` (writable)
| ID | Role | Unit | Description |
|----|------|------|-------------|
| power | switch.power | - | Turn inverter on/off |
| restart | button | - | Restart inverter MCU |
| power_limit_percent | level.power | % | Non-persistent power limit (2–100%) |
| power_limit_watt | level.power | W | Non-persistent power limit in watts |

## Changelog

### 0.0.1 (2026-03-28)
- Initial release

## License

MIT License

Copyright (c) 2026 Skeletor-ai <skeletor-ai@all-smart.net>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
