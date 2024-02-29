'use strict'

const axios = require('axios');

// From Heatzy API: https://drive.google.com/drive/folders/0B9nVzuTl4YMOaXAzRnRhdXVma1k
// https://heatzy.com/blog/tout-sur-heatzy
const heatzyUrl = "https://euapi.gizwits.com/app/";
const loginUrl = 'https://euapi.gizwits.com/app/login';
const heatzyApplicationId = "c70a66ff039d41b4a220e198b0fcc8b3";

// The following values are used in the API to get the mode. (To get the mode, the API returns of these strings)
const validModes = ['cft', 'eco', 'fro', 'off']; // Known values for the Heatzy mode
const validModesChinese = ['舒适','经济','解冻','停止'];

// The following values are used in the API to set the mode. (To set the mode, the API needs one of these values)
const cft = 0; // Comfort mode
const eco = 1; // Eco mode
const fro = 2; // Frozen (Hors Gel) mode
const off = 3; // Off mode

let Service, Characteristic

module.exports = (homebridge) => {
    // this is the starting point for the plugin where we register the accessory
    Service = homebridge.hap.Service
    Characteristic = homebridge.hap.Characteristic
    homebridge.registerAccessory(
		'homebridge-heatzy-as-switch',
		'HeatzyAsSwitch',
		SwitchAccessory
	);
};

function SwitchAccessory(log, config) {
    this.log = log;
    this.config = config;

	// Config
    this.getUrl = heatzyUrl + "devdata/" + config["did"] + "/latest";
    this.postUrl = heatzyUrl + "control/" + config["did"];
    this.name = config["name"];
    this.username = config["username"];
    this.password = config["password"];
    this.interval = config["interval"] || 60;
    this.trace = config["trace"] || false;

    this.switchOn = config["switchOn"] || "cft"; // default value is comfort mode
    if (!validModes.includes(this.switchOn)) {
        this.switchOn = "cft";
    }
    this.switchOff = config["switchOff"] || "eco"; // default value is eco mode
    if (!validModes.includes(this.switchOff)) {
        this.switchOff = "eco";
    }

    // Heatzy Token management
    this.heatzyToken = "";
    this.heatzyTokenExpireAt = Date.now() - 10000; // In ms since epoch time (January 1, 1970). Initial value is 10s in the past, to force login and refresh of token

    this.state = null; // Last state of the device, as known on Heatzy servers

    // Create a new information service. This just tells HomeKit about our accessory.
    this.informationService = new Service.AccessoryInformation()
        .setCharacteristic(Characteristic.Manufacturer, 'Heatzy')
        .setCharacteristic(Characteristic.Model, 'Heatzy Pilote V2')
        .setCharacteristic(Characteristic.SerialNumber, ' unknown');

    // Create the switch service
    this.service = new Service.Switch(this.config.name);

    // Add to the switch service the functions called to modify its characteristics
    this.service
        .getCharacteristic(Characteristic.On)
        .on('get', this.getOnCharacteristicHandler.bind(this))
        .on('set', this.setOnCharacteristicHandler.bind(this));

    this.updateState(); // Get the current state of the device, and update HomeKit
    setInterval(this.updateState.bind(this), 1000 * this.interval); // The state of the device will be checked at this interval (in sec)

    this.log("Starting HeatzyAsSwitch...");
}

async function updateToken(device) {
    try {
        const response = await axios({
            method: 'post',
            url: loginUrl,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-Gizwits-Application-Id': heatzyApplicationId,
            },
            data: {
                "username": device.username,
                "password": device.password,
                "lang": "en",
            }
        });

        if (response.status === 200) {
            device.heatzyToken = response.data.token;
            device.heatzyTokenExpireAt = 1000 * response.data.expire_at; // The API returns a date in seconds, but javascript works in ms...
            if (device.trace) {
                device.log('Logged in Heatzy server.');
            }
        } else {
            device.log('Error at login: ' + response.status + ' ' + response.statusText + ' ' + response.data.error_message);
        }
    } catch (error) {
        device.log('Error: Unable to log in to Heatzy server');
        device.log('Error message: ', error.message);
    }
}

async function getState(device) { //return the state of the device as a boolean. Or null if undefined
    if (device.heatzyTokenExpireAt < Date.now()) {
        await updateToken(device);
    }

    try {
        const response = await axios({
            method: 'get',
            url: device.getUrl,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-Gizwits-Application-Id': heatzyApplicationId,
                'X-Gizwits-User-token': device.heatzyToken,
            },
        });

        if (response.status !== 200) {
            device.log('Error: ' + response.status + ' ' + response.statusText + ' ' + response.data.error_message);
            return null;
        }

        let currentMode = response.data.attr.mode;

        if (validModesChinese.includes(currentMode)) {
            currentMode = validModes[validModesChinese.indexOf(currentMode)];
        }

        return currentMode === device.switchOn;
    } catch (error) {
        device.log('Error when getting state: ' + error.code);
        return null;
    }
}

async function setState(device, state) { // Set the state of the device, and return it if successful. Or null if failed
    if (device.heatzyTokenExpireAt < Date.now()) {
        await updateToken(device);
    }

    // Set mode to the value of the homekit switch
    let mode = device.switchOff;

    if (state) {
        mode = device.switchOn;
    }

    // The API works with literal modes (in 2023), but the specification is to use a numeric value. So we convert it.
    let modeNum = 0;

    switch (mode) {
        case "cft":
            modeNum = cft;
            break;
        case "eco":
            modeNum = eco;
            break;
        case "fro":
            modeNum = fro;
            break;
        case "off":
            modeNum = off;
    }

    try {
        const response = await axios({
            method: 'post',
            url: device.postUrl,
            headers: {
                'X-Gizwits-Application-Id': heatzyApplicationId,
                'X-Gizwits-User-token': device.heatzyToken,
            },
            data: {
                "attrs": {
                    "mode": modeNum
                }
            }
        });

        if (response.status !== 200) {
            device.log('Error: ' + response.status + ' ' + response.statusText + ' ' + response.data.error_message);
            state = null;
        }
    } catch (error) {
        device.log('Error when setting state: ' + error.code);
        state = null;
    }

    return state;
}

SwitchAccessory.prototype.updateState = async function () {
    let state = await getState(this);

    if (state !== null) {
        if (this.state === null) {
            // Initialize for first run
            this.state = state;
        }

        if (state !== this.state) {
            // If device state has changed since last update
            if (this.state && this.trace) {
                this.log('Switch state has changed from: ' + this.state + ' to ' + state);
            }

            this.state = state;
            this.service.updateCharacteristic(Characteristic.On, state);
        }
    }
    // If state is null (i.e unavailable from Heatzy server), do nothing because the device state will be updated at the next call
};

SwitchAccessory.prototype.getOnCharacteristicHandler = async function (callback) {
    let state = await getState(this);

    if (this.trace) {
        this.log('HomeKit asked for state (true for on, false for off): ' + state);
    }

    if (state != null) {
        callback(null, state);
    } else {
        this.log("Error: State unavailable");
        callback(true);
    }
};

SwitchAccessory.prototype.setOnCharacteristicHandler = async function (value, callback) {
    let state = await setState(this, value);

    if (this.trace) {
        this.log('HomeKit changed state to (true for on, false for off): ' + state);
    }

    //  This code only works when the new state is correctly reflected on Heatzy servers.
    // It is not always the case.

    if (state != null) {
        callback(null, state);
    } else {
        this.log("Error: Cannot change state");
        callback(true);
    }
};

SwitchAccessory.prototype.getServices = function () {
    this.log("Init services...");
    return [this.service, this.informationService];
};
