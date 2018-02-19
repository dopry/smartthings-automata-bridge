/*jslint node: true */
'use strict';



const 
    promisify = require('util').promisify,
    winston = require('winston'),
    express = require('express'),
    expressJoi = require('express-joi-validator'),
    expressWinston = require('express-winston'),
    bodyparser = require('body-parser'),
    mqtt = require('mqtt'),
    path = require('path'),
    joi = require('joi'),
    jsonfile = require('jsonfile'),
    semver = require('semver'),
    request = require('request');

    jsonfile.readFile = promisify(jsonfile.readFile),
    jsonfile.writeFile = promisify(jsonfile.writeFile);



const CONFIG_DIR = process.env.CONFIG_DIR || process.cwd(),
    STATE_FILE = path.join(CONFIG_DIR, 'state.json'),
    CURRENT_VERSION = require('./package').version;

var app = express(), client, config, state;

/**
 * Load user configuration (or create it)
 * @method loadConfiguration
 * @return {Object} Configuration
 */
async function loadConfiguration () {
    return {
        port: process.env.PORT || 8080,
        buildingId: process.env.BUILDING_ID || 1,
        mqtt: {
            host:  process.env.MQTT_HOST || 'mqtt://192.168.1.81',
            retain: process.env.MQTT_RETAIN || true,
        }         
    }
}

/**
 * Load the saved previous state from disk
 * @method loadSavedState
 * @return {Object} Configuration
 */
async function loadSavedState () {
    try {
        return await jsonfile.readFile(STATE_FILE);
    } catch (ex) {
        return { subscriptions: [], stHubUrl: '', history: {}, version: CURRENT_VERSION, devices: {} };
    }
}

/**
 * Resubscribe on a periodic basis
 * @method saveState
 */
async function saveState () {
    await jsonfile.writeFile(STATE_FILE, state, { spaces: 4 });
}

/**
 * Record device state into the devices tree.
 * @param {string} device 
 * @param {string} property 
 * @param {any} value 
 */
function updateDeviceState(device, property, value) {
    if (!state.devices.hasOwnProperty(device)) { 
        state.devices[device] = {};
        state.devices[device][property] = value;
        return;
    }
    if (!state.devices[device].hasOwnProperty(property)) {
        state.devices[device][property] = value;
        return;
    }
    state.devices[device][property] = value
    return;
}

/**
 * Handle Device Change/Push event from SmartThings
 *
 * @method handlePushEvent
 * @param  {Request} req
 * @param  {Object}  req.body
 * @param  {String}  req.body.name  Device Name (e.g. "Bedroom Light")
 * @param  {String}  req.body.type  Device Property (e.g. "state")
 * @param  {String}  req.body.value Value of device (e.g. "on")
 * @param  {Result}  res            Result Object
 */
async function handlePushEvent (req, res) {
    winston.info('handlePushEvent', JSON.stringify(req.body));
    let device = req.body.name,
        property = req.body.type.replace(' ', '_'),
        stValue =  req.body.value, 
        value = stValue,
        topic = getTopicFor(device, property);

    
    // map ST values to Automata values.
    switch (stValue) {
        case 'on': 
            value = 1;
            break;
        case 'off':
            value = 0;
            break;
        case 'heating':
            value = 1;
            break;
        case 'idle':
            value = 0;
            break;
        default: 
            value = parseFloat(value);
    }

    if (value === NaN) {
        value = stValue;
    }

    let valueKey = topic.split('/').join('.');

    let payloadObj = {};
    payloadObj[valueKey] = value;
    let payload = JSON.stringify(payloadObj);

    winston.info('Message from SmartThings: %s = %s', topic, payload);
    await client.publish(topic, payload, { retain: true });
    res.send({ status: 'OK' });
}

/**
 * Handle Subscribe event from SmartThings. This is fired when the MqttProxyApp on STCloud/Hub start up.
 *
 * @method handleSubscribeEvent
 * @param  {Request} req
 * @param  {Object}  req.body
 * @param  {Object}  req.body.devices  List of properties => device names
 * @param  {String}  req.body.callback Host and port for SmartThings Hub
 * @param  {Result}  res               Result Object
 */
async function handleSubscribeEvent (req, res) {
    state.stHubUrl = req.body.callback;
    saveState();
    return res.send({ status: 'OK' });
}


/**
 * Get the topic name for a given item
 * @method getTopicFor
 * @param  {String}    device   Device Name
 * @param  {String}    property Property
 * @param  {String}    suffix   Suffix for subscription
 * @return {String}             MQTT Topic name
 */
function getTopicFor (device, property, suffix) {
    return ['', 'b', config.buildingId, 'st', ...arguments ].join('/')
}

/**
 * Parse incoming message from MQTT
 * @method parseMQTTMessage
 * @param  {String} topic   Topic channel the event came from
 * @param  {String} message Contents of the event
 */
async function parseMQTTMessage (topic, message) {
    winston.info('parseMQTTMessage', topic);
    // Automata sends everything as JSON.
    let contents = JSON.parse(message.toString()), 
    value = contents.value;
    winston.info('Incoming message from MQTT: %s = %s', topic, message.toString());

    // start stripping the topic down to it's constituent parts. 
    let topicParts = topic.split('/');
    // b - building, u - users, d - mobile device, 
    entityType = topicParts.shift(),
    // depends on entity.
    entityId = topicParts.shift(),
    // st - smartthing, sw - struxureware
    system = topicParts.shift();

    if (entityType != 'b' || entityId != config.buildingId || system != 'st' ) {
        winston.info('Skipping Message not targeted at a ST device.')
        return;
    }

    let device = topicParts.shift()
    property = topicParts.shift(),
    stateTopic = getTopicFor(device, property),
    command = (topicParts.length > 0)
    
    let error, resp = await request.post({
        url: 'http://' + state.stHubUrl,
        json: {
            name: device,
            type: property,
            value,
            command
        }
    });

    if (error) {
        // @TODO handle the response from SmartThings
        winston.error('Error from SmartThings Hub: %s', error.toString());
        winston.error(JSON.stringify(error, null, 4));
        winston.error(JSON.stringify(resp, null, 4));
    }
}

async function main() {
    try {
        winston.info('Starting SmartThings Automata MQTT Bridge - v%s', CURRENT_VERSION);
        winston.info('Loading configuration');
        config = await loadConfiguration();

        winston.info('Loading previous state');
        state = await loadSavedState();

        winston.info('Connecting to MQTT at %s', config.mqtt.host);
        client = mqtt.connect(config.mqtt.host, config.mqtt);
        client.on('message', parseMQTTMessage);
        client.on('connect', function () {
            client.subscribe(getTopicFor());
        });

        winston.info('Configuring autosave');
        // Save current state every 15 minutes
        setInterval(saveState, 15 * 60 * 1000);

        winston.info('Configuring API');
        // Accept JSON
        app.use(bodyparser.json());
        // Log all requests to disk
        app.use(expressWinston.logger({ winstonInstance: winston }));
        // Push event from SmartThings
        app.post('/push', 
            expressJoi({
                body: { name: joi.string().required(), value: joi.string().required(), type: joi.string().required() }
            }), 
            handlePushEvent);
        // Subscribe event from SmartThings
        app.post('/subscribe', 
            expressJoi({ body: { devices: joi.object().required(), callback: joi.string().required() }}), 
            handleSubscribeEvent);
    
        // Proper error messages with Joi
        app.use(function (err, req, res, next) {
            if (err.isBoom) {
                winston.error('validation error', err.output.statusCode, err.output.payload );
                return res.status(err.output.statusCode).json(err.output.payload);
            }
            return winston.error('error', err);
        });

        await app.listen(config.port)
        winston.info('Listening at http://localhost:%s', config.port);
    }
    catch (error) {
        winston.error(error);
        process.exit(1);
    };
}

main();
