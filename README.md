# homebridge-grundfos-cim500

Plugin local para Homebridge controlar e monitorar bomba Grundfos CMBE/CME via CIM 500 Modbus TCP.

## O que aparece no Home iOS

1. **Bomba Pressurização**
   - Liga/desliga via Modbus.
   - Slider de velocidade usado como setpoint.
   - 0% = `minBar`.
   - 100% = `maxBar`.

2. **Bomba - Modo Local**
   - ON = devolve controle para o HMI local da bomba.
   - OFF = volta para remoto e liga.

3. **Motor Funcionando**
   - Sensor de ocupação.
   - Detectado = motor funcionando.
   - Não detectado = motor parado.

4. **Pressão Saída x10**
   - Sensor de temperatura usado como proxy.
   - Exemplo: 34,5 °C = 3,45 bar.

5. **Setpoint x10**
   - Sensor de umidade usado como proxy.
   - Exemplo: 35% = 3,50 bar.

6. **Totalizadores diários**
   - Min Funcionando Hoje.
   - Min Parado Hoje.
   - Ciclos Funcionando Hoje.
   - Ciclos Parada Hoje.

7. **Diagnósticos opcionais**
   - Rotação RPM.
   - Frequência Hz.
   - Corrente A x10.
   - Potência W.
   - Alarme Bomba.

## Instalação resumida

```bash
cd /tmp
unzip homebridge-grundfos-cim500.zip
cd homebridge-grundfos-cim500
sudo npm install -g .
```

Depois edite o `config.json` do Homebridge e adicione em `platforms`:

```json
{
  "platform": "GrundfosCim500",
  "name": "Grundfos CIM500",
  "host": "192.168.200.110",
  "port": 502,
  "unitId": 1,
  "pollIntervalMs": 5000,
  "minBar": 2.2,
  "maxBar": 3.8,
  "defaultBar": 3.5,
  "setConstantPressureOnStart": true,
  "exposeDiagnostics": true
}
```

Reinicie:

```bash
sudo systemctl restart homebridge
```

## Segurança operacional

- O botão OFF da bomba coloca a bomba em **Remote + Off**: `00101 = 1`.
- O botão ON escreve:
  - `00102 = 4` Constant Pressure.
  - `00104 = setpoint remoto`.
  - `00101 = 3` Remote + On.
- O switch **Modo Local** ON escreve:
  - `00101 = 0`.

Para uso residencial, mantenha o switch **Modo Local** disponível como fallback.
