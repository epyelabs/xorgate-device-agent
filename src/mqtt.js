import mqtt from 'mqtt';

/**
 * Connect to AWS IoT Core over mTLS (MQTT v5). `clientId` MUST equal the IoT
 * thing name (= the canonical device id): the device IoT policy scopes
 * `iot:Connect` to `client/${iot:Connection.Thing.ThingName}`.
 *
 * A Last-Will message is registered on the status topic so an ungraceful
 * disconnect is observable cloud-side.
 */
export function connect(config) {
  const { endpoint, deviceId, creds, statusTopic } = config;

  const will = {
    topic: statusTopic,
    payload: JSON.stringify({ v: 1, deviceId, ts: Date.now(), online: false }),
    qos: 0,
    retain: false,
  };

  return mqtt.connect(`mqtts://${endpoint}:8883`, {
    key: creds.key,
    cert: creds.cert,
    ca: [creds.ca],
    clientId: deviceId,
    protocolId: 'MQTT',
    protocolVersion: 5,
    clean: true,
    reconnectPeriod: 2000,
    connectTimeout: 30_000,
    will,
  });
}
