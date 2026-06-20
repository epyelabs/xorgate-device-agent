import { EventEmitter } from "node:events";
import mqtt from "mqtt";
import type { AgentConfig } from "./config.js";

/**
 * The slice of an mqtt client the worker actually uses. Both the real
 * `mqtt.MqttClient` and the offline stub satisfy this, so the worker code is
 * identical in both modes.
 */
export interface AgentClient {
  on(event: "connect" | "reconnect" | "close", handler: () => void): unknown;
  on(event: "error", handler: (err: Error) => void): unknown;
  publish(
    topic: string,
    message: string,
    opts: { qos: 0 | 1 | 2; retain?: boolean },
    cb?: (err?: Error) => void,
  ): unknown;
  end(force: boolean, opts: Record<string, never>, cb: () => void): unknown;
}

/**
 * Connect to AWS IoT Core over mTLS (MQTT v5). `clientId` MUST equal the IoT
 * thing name (= the canonical device id): the device IoT policy scopes
 * `iot:Connect` to `client/${iot:Connection.Thing.ThingName}`.
 *
 * A Last-Will message is registered on the status topic so an ungraceful
 * disconnect is observable cloud-side.
 *
 * In offline mode a network-free stub client is returned instead.
 */
export function connect(config: AgentConfig): AgentClient {
  if (config.offline) return createStubClient();

  const { endpoint, deviceId, creds, statusTopic } = config;
  if (!creds) throw new Error("missing creds for online connect (internal)");

  const will = {
    topic: statusTopic,
    payload: JSON.stringify({ v: 1, deviceId, ts: Date.now(), online: false }),
    qos: 0 as const,
    retain: false,
  };

  return mqtt.connect(`mqtts://${endpoint}:8883`, {
    key: creds.key,
    cert: creds.cert,
    ca: [creds.ca],
    clientId: deviceId,
    protocolId: "MQTT",
    protocolVersion: 5,
    clean: true,
    reconnectPeriod: 2000,
    connectTimeout: 30_000,
    will,
  }) as unknown as AgentClient;
}

/**
 * Network-free stand-in for the mqtt client. Emits `connect` on the next tick,
 * counts publishes as no-ops, and resolves `end()`. Used by `--offline` so the
 * full daemon + monitor stack can run without AWS creds or connectivity.
 */
export function createStubClient(): AgentClient {
  const emitter = new EventEmitter();
  // Defer so the worker's `.on('connect', …)` is registered before we fire it.
  // NOT unref'd: it must keep the event loop alive until connect fires (the real
  // mqtt socket does that job online). Once connect runs, the ref'd publish
  // interval keeps the worker alive.
  setTimeout(() => emitter.emit("connect"), 0);

  const client = {
    on(event: string, handler: (...a: never[]) => void) {
      emitter.on(event, handler as (...args: unknown[]) => void);
      return client;
    },
    publish(_topic: string, _message: string, _opts: unknown, cb?: (err?: Error) => void) {
      cb?.(undefined);
      return client;
    },
    end(_force: boolean, _opts: Record<string, never>, cb: () => void) {
      cb();
      return client;
    },
  };
  // Structural overloads on `on` don't unify with a single impl signature; the
  // EventEmitter handles the args at runtime, so cast like the real client.
  return client as unknown as AgentClient;
}
