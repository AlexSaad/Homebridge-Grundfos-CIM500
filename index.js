'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');

const PLUGIN_NAME = 'homebridge-grundfos-cim500';
const PLATFORM_NAME = 'GrundfosCim500';

let Service;
let Characteristic;
let UUIDGen;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, GrundfosCim500Platform);
};

class GrundfosCim500Platform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessory = null;

    this.name = this.config.name || 'Grundfos CIM500';
    this.host = this.config.host || '192.168.200.110';
    this.port = Number(this.config.port || 502);
    this.unitId = Number(this.config.unitId || 1);
    this.pollIntervalMs = Number(this.config.pollIntervalMs || 5000);
    this.minBar = Number(this.config.minBar || 2.2);
    this.maxBar = Number(this.config.maxBar || 3.8);
    this.defaultBar = Number(this.config.defaultBar || 3.5);
    this.setConstantPressureOnStart = this.config.setConstantPressureOnStart !== false;
    this.exposeDiagnostics = this.config.exposeDiagnostics !== false;

    this.txId = 1;
    this.lastSetpointBar = this.defaultBar;
    this.pollTimer = null;
    this.services = {};
    this.state = this.createEmptyDailyState();
    this.metrics = this.createEmptyMetrics();

    this.stateFile = path.join(this.api.user.storagePath(), 'grundfos-cim500-daily-state.json');

    this.api.on('didFinishLaunching', () => {
      this.loadDailyState();
      this.setupAccessory();
      this.startPolling();
    });
  }

  configureAccessory(accessory) {
    this.accessory = accessory;
  }

  createEmptyMetrics() {
    return {
      ok: false,
      isLocal: true,
      isRemote: false,
      commandOn: false,
      running: false,
      forcedToLocal: false,
      lowFlowStop: false,
      atMinSpeed: false,
      atMaxSpeed: false,
      alarm: false,
      warning: false,
      controlSource: 'UNKNOWN',
      alarmCode: 0,
      warningCode: 0,
      pressureBar: 0,
      userSetpointBar: this.defaultBar,
      actualSetpointBar: this.defaultBar,
      sensorMaxBar: 6,
      speedRpm: 0,
      frequencyHz: 0,
      currentA: 0,
      powerW: 0,
      statusRaw: 0
    };
  }

  createEmptyDailyState() {
    return {
      day: this.dayString(new Date()),
      runningSeconds: 0,
      stoppedSeconds: 0,
      runningCycles: 0,
      stoppedCycles: 0,
      lastState: '',
      lastTs: Math.floor(Date.now() / 1000)
    };
  }

  dayString(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  midnightTs(date = new Date()) {
    return Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0).getTime() / 1000);
  }

  loadDailyState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        this.state = Object.assign(this.createEmptyDailyState(), parsed);
      }
    } catch (err) {
      this.log.warn(`Não foi possível carregar estado diário: ${err.message}`);
      this.state = this.createEmptyDailyState();
    }
  }

  saveDailyState() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch (err) {
      this.log.warn(`Não foi possível salvar estado diário: ${err.message}`);
    }
  }

  updateDailyCounters(isRunning) {
    const now = Math.floor(Date.now() / 1000);
    const today = this.dayString(new Date());
    const currentState = isRunning ? 'FUNCIONANDO' : 'PARADA';

    if (this.state.day !== today) {
      this.state = {
        day: today,
        runningSeconds: 0,
        stoppedSeconds: 0,
        runningCycles: currentState === 'FUNCIONANDO' ? 1 : 0,
        stoppedCycles: currentState === 'PARADA' ? 1 : 0,
        lastState: currentState,
        lastTs: this.midnightTs(new Date())
      };
    }

    let elapsed = now - this.state.lastTs;
    if (elapsed < 0 || elapsed > 3600) elapsed = 0;

    if (this.state.lastState === 'FUNCIONANDO') this.state.runningSeconds += elapsed;
    else if (this.state.lastState === 'PARADA') this.state.stoppedSeconds += elapsed;

    if (currentState !== this.state.lastState) {
      if (currentState === 'FUNCIONANDO') this.state.runningCycles += 1;
      else this.state.stoppedCycles += 1;
    }

    this.state.lastState = currentState;
    this.state.lastTs = now;
    this.saveDailyState();
  }

  setupAccessory() {
    const uuid = UUIDGen.generate('grundfos-cim500-main-accessory');
    if (!this.accessory) {
      this.accessory = new this.api.platformAccessory(this.name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.accessory]);
    }

    this.accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Grundfos')
      .setCharacteristic(Characteristic.Model, 'CMBE/CME via CIM 500')
      .setCharacteristic(Characteristic.SerialNumber, 'CIM500-ModbusTCP')
      .setCharacteristic(Characteristic.FirmwareRevision, 'homebridge-plugin-1.0.0');

    this.setupFanService();
    this.setupLocalSwitchService();
    this.setupRunningService();
    this.setupPressureService();
    this.setupSetpointService();
    this.setupDailyServices();
    if (this.exposeDiagnostics) this.setupDiagnosticsServices();
  }

  setupFanService() {
    const svc = this.accessory.getService(Service.Fanv2) || this.accessory.addService(Service.Fanv2, 'Bomba Pressurização');
    this.services.fan = svc;

    svc.getCharacteristic(Characteristic.Active)
      .onGet(() => this.metrics.commandOn ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE)
      .onSet(async (value) => {
        if (Number(value) === Characteristic.Active.ACTIVE) await this.forceRemoteOn(this.lastSetpointBar || this.defaultBar);
        else await this.forceRemoteOff();
      });

    svc.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(() => this.barToSlider(this.metrics.userSetpointBar || this.lastSetpointBar || this.defaultBar))
      .onSet(async (value) => {
        const bar = this.sliderToBar(Number(value));
        this.lastSetpointBar = bar;
        await this.forceRemoteOn(bar);
      });

    svc.getCharacteristic(Characteristic.CurrentFanState)
      .onGet(() => {
        if (!this.metrics.commandOn) return Characteristic.CurrentFanState.INACTIVE;
        return this.metrics.running ? Characteristic.CurrentFanState.BLOWING_AIR : Characteristic.CurrentFanState.IDLE;
      });

    svc.getCharacteristic(Characteristic.TargetFanState)
      .onGet(() => Characteristic.TargetFanState.AUTO)
      .onSet(() => null);
  }

  setupLocalSwitchService() {
    const svc = this.accessory.getServiceById(Service.Switch, 'local-mode') ||
      this.accessory.addService(Service.Switch, 'Bomba - Modo Local', 'local-mode');
    this.services.localSwitch = svc;
    svc.getCharacteristic(Characteristic.On)
      .onGet(() => this.metrics.isLocal)
      .onSet(async (value) => {
        if (value) await this.forceLocal();
        else await this.forceRemoteOn(this.lastSetpointBar || this.defaultBar);
      });
  }

  setupRunningService() {
    const svc = this.accessory.getServiceById(Service.OccupancySensor, 'running') ||
      this.accessory.addService(Service.OccupancySensor, 'Motor Funcionando', 'running');
    this.services.running = svc;
    svc.getCharacteristic(Characteristic.OccupancyDetected)
      .onGet(() => this.metrics.running ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
  }

  setupPressureService() {
    const svc = this.accessory.getServiceById(Service.TemperatureSensor, 'pressure-x10') ||
      this.accessory.addService(Service.TemperatureSensor, 'Pressão Saída x10', 'pressure-x10');
    this.services.pressure = svc;
    svc.getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: 0, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.round1(this.metrics.pressureBar * 10));
  }

  setupSetpointService() {
    const svc = this.accessory.getServiceById(Service.HumiditySensor, 'setpoint-x10') ||
      this.accessory.addService(Service.HumiditySensor, 'Setpoint x10', 'setpoint-x10');
    this.services.setpoint = svc;
    svc.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .setProps({ minValue: 0, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.round1(this.metrics.userSetpointBar * 10));
  }

  setupDailyServices() {
    this.services.runningMinutes = this.addLightSensor('Min Funcionando Hoje', 'running-minutes');
    this.services.stoppedMinutes = this.addLightSensor('Min Parado Hoje', 'stopped-minutes');
    this.services.runningCycles = this.addLightSensor('Ciclos Funcionando Hoje', 'running-cycles');
    this.services.stoppedCycles = this.addLightSensor('Ciclos Parada Hoje', 'stopped-cycles');
  }

  setupDiagnosticsServices() {
    this.services.speed = this.addLightSensor('Rotação RPM', 'speed-rpm');
    this.services.frequency = this.addLightSensor('Frequência Hz', 'frequency-hz');
    this.services.current = this.addLightSensor('Corrente A x10', 'current-x10');
    this.services.power = this.addLightSensor('Potência W', 'power-w');
    const alarmSvc = this.accessory.getServiceById(Service.LeakSensor, 'alarm') ||
      this.accessory.addService(Service.LeakSensor, 'Alarme Bomba', 'alarm');
    this.services.alarm = alarmSvc;
    alarmSvc.getCharacteristic(Characteristic.LeakDetected).onGet(() =>
      this.metrics.alarm ? Characteristic.LeakDetected.LEAK_DETECTED : Characteristic.LeakDetected.LEAK_NOT_DETECTED);
  }

  addLightSensor(name, subtype) {
    const svc = this.accessory.getServiceById(Service.LightSensor, subtype) ||
      this.accessory.addService(Service.LightSensor, name, subtype);
    svc.getCharacteristic(Characteristic.CurrentAmbientLightLevel)
      .setProps({ minValue: 0.0001, maxValue: 100000, minStep: 0.0001 });
    return svc;
  }

  updateHomeKitValues() {
    const m = this.metrics;
    const s = this.state;
    this.services.fan?.getCharacteristic(Characteristic.Active).updateValue(m.commandOn ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
    this.services.fan?.getCharacteristic(Characteristic.RotationSpeed).updateValue(this.barToSlider(m.userSetpointBar || this.lastSetpointBar || this.defaultBar));
    this.services.fan?.getCharacteristic(Characteristic.CurrentFanState).updateValue(!m.commandOn ? Characteristic.CurrentFanState.INACTIVE : (m.running ? Characteristic.CurrentFanState.BLOWING_AIR : Characteristic.CurrentFanState.IDLE));
    this.services.localSwitch?.getCharacteristic(Characteristic.On).updateValue(m.isLocal);
    this.services.running?.getCharacteristic(Characteristic.OccupancyDetected).updateValue(m.running ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    this.services.pressure?.getCharacteristic(Characteristic.CurrentTemperature).updateValue(this.round1(m.pressureBar * 10));
    this.services.setpoint?.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(this.round1(m.userSetpointBar * 10));
    this.updateLux(this.services.runningMinutes, s.runningSeconds / 60);
    this.updateLux(this.services.stoppedMinutes, s.stoppedSeconds / 60);
    this.updateLux(this.services.runningCycles, s.runningCycles);
    this.updateLux(this.services.stoppedCycles, s.stoppedCycles);
    if (this.exposeDiagnostics) {
      this.updateLux(this.services.speed, m.speedRpm);
      this.updateLux(this.services.frequency, m.frequencyHz);
      this.updateLux(this.services.current, m.currentA * 10);
      this.updateLux(this.services.power, m.powerW || 0);
      this.services.alarm?.getCharacteristic(Characteristic.LeakDetected).updateValue(m.alarm ? Characteristic.LeakDetected.LEAK_DETECTED : Characteristic.LeakDetected.LEAK_NOT_DETECTED);
    }
  }

  updateLux(service, value) {
    if (!service) return;
    const v = Math.max(0.0001, Math.min(100000, Number(value) || 0.0001));
    service.getCharacteristic(Characteristic.CurrentAmbientLightLevel).updateValue(v);
  }

  round1(n) { return Math.round(Number(n || 0) * 10) / 10; }
  round3(n) { return Math.round(Number(n || 0) * 1000) / 1000; }

  startPolling() {
    this.pollOnce();
    this.pollTimer = setInterval(() => this.pollOnce(), this.pollIntervalMs);
  }

  async pollOnce() {
    try {
      await this.readAll();
      this.updateDailyCounters(this.metrics.running);
      this.updateHomeKitValues();
    } catch (err) {
      this.metrics.ok = false;
      this.log.warn(`Falha de leitura CIM500: ${err.message}`);
    }
  }

  hregToPdu(addrHuman) { return addrHuman - 1; }

  sendModbusPdu(pdu) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const transactionId = this.txId = (this.txId + 1) & 0xffff;
      const mbap = Buffer.alloc(7);
      mbap.writeUInt16BE(transactionId, 0);
      mbap.writeUInt16BE(0, 2);
      mbap.writeUInt16BE(pdu.length + 1, 4);
      mbap.writeUInt8(this.unitId, 6);
      const packet = Buffer.concat([mbap, pdu]);
      let chunks = [];
      let done = false;
      const finish = (err, data) => {
        if (done) return;
        done = true;
        socket.destroy();
        err ? reject(err) : resolve(data);
      };
      socket.setTimeout(3000);
      socket.on('timeout', () => finish(new Error('timeout')));
      socket.on('error', (err) => finish(err));
      socket.on('data', (chunk) => {
        chunks.push(chunk);
        const buf = Buffer.concat(chunks);
        if (buf.length < 7) return;
        const len = buf.readUInt16BE(4);
        const total = 6 + len;
        if (buf.length < total) return;
        const respPdu = buf.subarray(7, total);
        const fc = respPdu.readUInt8(0);
        if ((fc & 0x80) === 0x80) return finish(new Error(`Modbus exception ${respPdu.readUInt8(1)}`));
        finish(null, respPdu);
      });
      socket.connect(this.port, this.host, () => socket.write(packet));
    });
  }

  async readInputRegisters(addrHuman, quantity) {
    const addr = this.hregToPdu(addrHuman);
    const pdu = Buffer.from([0x04, (addr >> 8) & 0xff, addr & 0xff, (quantity >> 8) & 0xff, quantity & 0xff]);
    const resp = await this.sendModbusPdu(pdu);
    if (resp.readUInt8(0) !== 0x04) throw new Error(`função inesperada ${resp.readUInt8(0)}`);
    const byteCount = resp.readUInt8(1);
    if (byteCount !== quantity * 2) throw new Error(`byte count inesperado ${byteCount}`);
    const out = [];
    for (let i = 0; i < quantity; i++) out.push(resp.readUInt16BE(2 + i * 2));
    return out;
  }

  async writeSingleRegister(addrHuman, value) {
    const addr = this.hregToPdu(addrHuman);
    const v = Math.max(0, Math.min(65535, Math.round(Number(value))));
    const pdu = Buffer.from([0x06, (addr >> 8) & 0xff, addr & 0xff, (v >> 8) & 0xff, v & 0xff]);
    const resp = await this.sendModbusPdu(pdu);
    if (resp.readUInt8(0) !== 0x06) throw new Error(`função inesperada ${resp.readUInt8(0)}`);
  }

  async readAll() {
    const status = await this.readInputRegisters(201, 25);
    const data = await this.readInputRegisters(304, 37);
    const reg = (base, arr, human) => arr[human - base];
    const r201 = reg(201, status, 201), r205 = reg(201, status, 205), r206 = reg(201, status, 206), r211 = reg(201, status, 211), r225 = reg(201, status, 225);
    const r304 = reg(304, data, 304), r305 = reg(304, data, 305), r308 = reg(304, data, 308), r309 = reg(304, data, 309), r312 = reg(304, data, 312), r313 = reg(304, data, 313), r338 = reg(304, data, 338), r340 = reg(304, data, 340);
    const sensorMaxBar = this.raw001ToBar(r211 || 6000);
    const pressureBar = this.raw001ToBar(r340 || 0);
    const userSetpointBar = this.pctRawToBar(r338 || 0, sensorMaxBar);
    const actualSetpointBar = this.pctRawToBar(r308 || 0, sensorMaxBar);
    const speedRpm = r304 || 0;
    const frequencyHz = (r305 || 0) / 10;
    const currentA = (r309 || 0) / 10;
    const power32 = ((r312 || 0) << 16) + (r313 || 0);
    const powerW = this.sanitizePowerW(power32, speedRpm, frequencyHz, currentA);
    const isRemote = this.bit(r201, 8);
    const commandOn = this.bit(r201, 9);
    if (userSetpointBar > 0.1) this.lastSetpointBar = userSetpointBar;
    this.metrics = {
      ok: true,
      isLocal: !isRemote,
      isRemote,
      commandOn,
      running: speedRpm > 0 || frequencyHz > 0 || currentA > 0,
      forcedToLocal: this.bit(r201, 12),
      lowFlowStop: this.bit(r201, 0),
      atMinSpeed: this.bit(r201, 15),
      atMaxSpeed: this.bit(r201, 13),
      alarm: this.bit(r201, 10) || (r205 || 0) !== 0,
      warning: this.bit(r201, 11) || (r206 || 0) !== 0,
      controlSource: this.decodeControlSource(r225 || 0),
      alarmCode: r205 || 0,
      warningCode: r206 || 0,
      pressureBar: this.round3(pressureBar),
      userSetpointBar: this.round3(userSetpointBar),
      actualSetpointBar: this.round3(actualSetpointBar),
      sensorMaxBar: this.round3(sensorMaxBar),
      speedRpm,
      frequencyHz: this.round1(frequencyHz),
      currentA: this.round1(currentA),
      powerW,
      statusRaw: r201
    };
  }

  bit(value, n) { return ((value >> n) & 1) === 1; }
  raw001ToBar(raw) { return raw / 1000; }
  pctRawToBar(rawPct, sensorMaxBar) { return (rawPct / 10000) * sensorMaxBar; }
  barToPctRaw(bar, sensorMaxBar) { return Math.round((bar / (sensorMaxBar || 6)) * 10000); }
  sliderToBar(rotationSpeedPct) { return this.round3(this.minBar + (Math.max(0, Math.min(100, Number(rotationSpeedPct || 0))) / 100) * (this.maxBar - this.minBar)); }
  barToSlider(bar) { return Math.round(Math.max(0, Math.min(100, ((Number(bar || 0) - this.minBar) / (this.maxBar - this.minBar)) * 100))); }
  sanitizePowerW(power32, speedRpm, frequencyHz, currentA) { if (power32 === 65535 || power32 === 4294967295 || Number.isNaN(power32)) return 0; if (speedRpm === 0 && frequencyHz === 0 && currentA === 0) return 0; return power32; }
  decodeControlSource(value) { const m = {1:'DISPLAY',2:'BUS',3:'HANDHELD',4:'DIGITAL_INPUT',5:'BUTTON'}; return m[Number(value)] || `UNKNOWN(${value})`; }

  async forceRemoteOn(setpointBar) {
    const sensorMaxBar = this.metrics.sensorMaxBar || 6;
    const setpointRaw = this.barToPctRaw(setpointBar, sensorMaxBar);
    if (this.setConstantPressureOnStart) await this.writeSingleRegister(102, 4);
    await this.writeSingleRegister(104, setpointRaw);
    await this.writeSingleRegister(101, 3);
    this.lastSetpointBar = setpointBar;
    await this.readAll();
    this.updateHomeKitValues();
  }

  async forceRemoteOff() {
    await this.writeSingleRegister(101, 1);
    await this.readAll();
    this.updateHomeKitValues();
  }

  async forceLocal() {
    await this.writeSingleRegister(101, 0);
    await this.readAll();
    this.updateHomeKitValues();
  }
}
