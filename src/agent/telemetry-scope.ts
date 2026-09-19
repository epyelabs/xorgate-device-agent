/**
 * Which telemetry topic this device publishes on, and how it gets out of the
 * one failure mode that has ever taken the fleet down.
 *
 * ## The topic
 *
 * A device boots publishing to the UNSCOPED topic
 * `xorgate/devices/{deviceId}/telemetry`, which the device IoT policy always
 * permits, and switches to the tenant-scoped topic
 * `xorgate/orgs/{org}/ws/{ws}/devices/{deviceId}/telemetry` the moment the
 * retained config message tells it which tenant it is in. Both planes are
 * ingested cloud-side (`xorgate_telemetry_ingest` and `…_scoped` both wildcard
 * the tenancy), so the unscoped plane is a DEGRADED mode, not a dead one:
 * history and `device_latest` keep filling. What it loses is the third-party
 * live path — a vended credential is scoped to one concrete topic string.
 *
 * ## The failure mode this exists for (2026-09-18, ~50 minutes of production)
 *
 * The scoped topic is authorized by THING ATTRIBUTES (`xgOrgId`/`xgWorkspaceId`)
 * that the cloud writes, and instructed by the retained config's `scope` block.
 * They are two different writes. If the attribute moves to a new tenant while a
 * running agent is still pinned to the old topic:
 *
 *   publish -> broker refuses -> IoT Core CLOSES THE CONNECTION -> reconnect ->
 *   publish -> …
 *
 * every ~3.3 s, forever. The broker does replay the retained config ~0.5 s after
 * each connect, but the 1 Hz publish timer usually wins the race and kills the
 * connection first. Observed losing that race for 50 minutes; the only exit was
 * `systemctl restart xorgate-agent`, because a fresh process starts on the
 * unscoped topic and therefore survives long enough to read its config.
 *
 * ## What this does about it
 *
 * Watch the shape of that loop and, once it is unmistakable, do voluntarily what
 * a restart would have done: drop to the unscoped topic. Fail OPEN to the legacy
 * plane, never into a loop.
 *
 * The signature is a connection that died in under `shortConnectionMs` while the
 * scoped topic was armed and this agent had actually published on it. One of
 * those is nothing — a tunnel blink looks the same. A RUN of them that has been
 * going for at least `graceMs` is the loop, and nothing else the agent does
 * produces it.
 *
 * "Had actually published" is deliberately CUMULATIVE (since the topic was
 * armed), not per-connection. Requiring a publish inside each short window is
 * the obvious way to write this and it does not work: measured against the real
 * loop on the bench (2026-09-19), the broker cycles every ~2.3 s while the agent
 * publishes at 1 Hz and mqtt.js queues across the gaps, so a good fraction of
 * connections carry no publish CALLBACK at all. Resetting the run on those means
 * a 30 s unbroken run essentially never happens — the loop ran past 70 s
 * untouched before this was fixed. A connection that dies in under five seconds
 * is evidence whether or not a callback happened to land inside it.
 *
 * `graceMs` (30 s) is the important number and it is chosen against a real
 * observation, not a hunch: a correctly-ordered transfer whose two writes were
 * 12 s apart flapped for those 12 s and then settled (Tacloban 03). Falling back
 * there would be a regression — the device was converging. 30 s is comfortably
 * past any sane gap between two cloud API calls and comfortably short of 50
 * minutes.
 *
 * ## Getting back
 *
 * Two ways up, and deliberately no others:
 *
 * - **A config message carrying a DIFFERENT scope.** The retained message is
 *   replayed on every single connect, so re-arming on any scope at all would
 *   put us straight back in the loop 0.5 s later. Re-arming only on a change is
 *   what makes this "one transition down, one transition up" instead of a
 *   slower flap.
 * - **A timed re-probe**, 30 min after the fallback and doubling to a 6 h
 *   ceiling. This covers the case the first rule cannot see: an operator fixes
 *   the THING ATTRIBUTE to match the scope the device already has. That
 *   publishes no new config message — the scope did not change — so without a
 *   probe the device would sit on the legacy plane until someone restarted it.
 *   A failed probe costs one ~3 s cycle (after the first fallback a single bad
 *   cycle is enough; we already know what this looks like) and re-arms the
 *   backoff.
 */

export interface TenantScope {
  organizationId: string;
  workspaceId: string;
}

/** A topic change the worker should log, publish on, and report. */
export type ScopeChange =
  | {
      kind: "scoped";
      topic: string;
      scope: TenantScope;
      /** `cloud` = a config message moved us; `reprobe` = the backoff timer did. */
      reason: "cloud" | "reprobe";
    }
  | {
      kind: "fallback";
      topic: string;
      /** The scope we could not publish under. */
      scope: TenantScope;
      /** Consecutive bad cycles that triggered it. */
      cycles: number;
      /** How long until the next re-probe, ms. */
      reprobeInMs: number;
    };

export interface TelemetryScopeOptions {
  /** `xorgate/devices/{deviceId}/telemetry` — always permitted by the policy. */
  unscopedTopic: string;
  deviceId: string;
  /** A connection shorter than this, on an armed scoped topic, is "suspicious". */
  shortConnectionMs?: number;
  /** Consecutive suspicious cycles before the FIRST fallback. */
  failureThreshold?: number;
  /** …and the run must have lasted at least this long. See the header. */
  graceMs?: number;
  /** First re-probe delay after a fallback; doubles per failed probe. */
  reprobeAfterMs?: number;
  /** Ceiling for that doubling. */
  maxReprobeMs?: number;
}

const DEFAULTS = {
  shortConnectionMs: 5_000,
  failureThreshold: 3,
  graceMs: 30_000,
  reprobeAfterMs: 30 * 60_000,
  maxReprobeMs: 6 * 60 * 60_000,
};

/** Reported-only view of where telemetry is going and why. */
export interface TelemetryScopeReport {
  topic: string;
  /** True while publishing on the tenant-scoped topic. */
  scoped: boolean;
  /** The tenancy the cloud last named, if any. */
  organizationId?: string;
  workspaceId?: string;
  /** Present ONLY while fallen back — its absence is the healthy state. */
  fallback?: {
    /** Epoch ms of the fallback. */
    since: number;
    /** Fallbacks for the current desired scope (a re-probe failure adds one). */
    count: number;
  };
}

export function scopedTelemetryTopic(scope: TenantScope, deviceId: string): string {
  return `xorgate/orgs/${scope.organizationId}/ws/${scope.workspaceId}/devices/${deviceId}/telemetry`;
}

function sameScope(a: TenantScope | null, b: TenantScope): boolean {
  return (
    a !== null && a.organizationId === b.organizationId && a.workspaceId === b.workspaceId
  );
}

export class TelemetryScope {
  private readonly opts: Required<TelemetryScopeOptions>;
  /** The tenancy the cloud last told us about; null until the first config message. */
  private desired: TenantScope | null = null;
  /** True while we are publishing on the scoped topic. */
  private scoped = false;
  /**
   * Start of the current measurement cycle: the later of "we connected" and "we
   * armed the scoped topic". Measuring from the connect alone would make a
   * re-probe on a long-lived healthy connection look like a healthy cycle no
   * matter what the broker did to it. null = not connected.
   */
  private cycleStartedAt: number | null = null;
  /**
   * Publishes on the scoped topic since it was armed. Cumulative on purpose —
   * see the header. It only has to answer "have we ever offered this topic to
   * the broker", which is what separates "refused" from "never tried".
   */
  private publishesSinceArm = 0;
  /** Consecutive suspicious cycles, and when the run began. */
  private runCycles = 0;
  private runStartedAt = 0;
  /** Epoch ms of the current fallback; null = not fallen back. */
  private fallbackAt: number | null = null;
  /** Fallbacks for the CURRENT desired scope. 0 = never, so use the full threshold. */
  private fallbackCount = 0;
  /** Next re-probe delay, ms. Doubles per failed probe, capped. */
  private probeDelayMs = 0;

  constructor(opts: TelemetryScopeOptions) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** The topic to publish telemetry on right now. */
  get topic(): string {
    return this.scoped && this.desired
      ? scopedTelemetryTopic(this.desired, this.opts.deviceId)
      : this.opts.unscopedTopic;
  }

  /** True while degraded to the legacy plane despite knowing a tenancy. */
  get fallenBack(): boolean {
    return this.fallbackAt !== null;
  }

  /**
   * A config message carried a `scope`. Returns the change to log, or null when
   * nothing moved — which is the common case, because this message is RETAINED
   * and the broker replays it on every connect.
   */
  applyScope(scope: TenantScope, now: number): ScopeChange | null {
    if (sameScope(this.desired, scope)) {
      // Same tenancy we already know about. If we are fallen back, STAY — see
      // the header: re-arming here is the flap this whole class avoids.
      return null;
    }
    this.desired = scope;
    this.fallbackAt = null;
    this.fallbackCount = 0;
    this.probeDelayMs = 0;
    this.armScoped(now);
    return { kind: "scoped", topic: this.topic, scope, reason: "cloud" };
  }

  /** MQTT connected. */
  noteConnect(now: number): void {
    this.cycleStartedAt = now;
  }

  /** A telemetry publish left the client on the current topic. */
  notePublish(): void {
    if (this.scoped) this.publishesSinceArm += 1;
  }

  /**
   * MQTT connection closed. Returns a fallback change when this closed the run
   * that proves the scoped topic is refused. Must NOT be called for a shutdown
   * close — that is us, not the broker.
   */
  noteClose(now: number): ScopeChange | null {
    const startedAt = this.cycleStartedAt;
    this.cycleStartedAt = null;

    // A cycle says nothing about the scoped topic unless we were using it and
    // have offered it to the broker at least once.
    if (!this.scoped || this.desired === null || this.publishesSinceArm === 0) {
      this.runCycles = 0;
      return null;
    }
    // A close with no connection behind it — a handshake that never completed —
    // is not evidence either way, so it neither counts nor clears the run.
    if (startedAt === null) return null;
    if (now - startedAt >= this.opts.shortConnectionMs) {
      // Long enough to be a working connection. Whatever we were watching, it
      // is over.
      this.runCycles = 0;
      return null;
    }
    if (this.runCycles === 0) this.runStartedAt = now;
    this.runCycles += 1;

    // After the first fallback for this scope one bad cycle is enough: we are
    // re-probing a topic we already watched fail, and there is nothing to learn
    // by watching it fail three more times.
    const needCycles = this.fallbackCount > 0 ? 1 : this.opts.failureThreshold;
    const needGraceMs = this.fallbackCount > 0 ? 0 : this.opts.graceMs;
    if (this.runCycles < needCycles) return null;
    if (now - this.runStartedAt < needGraceMs) return null;

    const cycles = this.runCycles;
    const scope = this.desired;
    this.scoped = false;
    this.runCycles = 0;
    this.fallbackAt = now;
    this.fallbackCount += 1;
    this.probeDelayMs =
      this.probeDelayMs === 0
        ? this.opts.reprobeAfterMs
        : Math.min(this.probeDelayMs * 2, this.opts.maxReprobeMs);
    return {
      kind: "fallback",
      topic: this.topic,
      scope,
      cycles,
      reprobeInMs: this.probeDelayMs,
    };
  }

  /**
   * Called on the publish tick. Returns a change when the backoff has elapsed
   * and it is time to try the scoped topic again.
   */
  noteTick(now: number): ScopeChange | null {
    if (this.fallbackAt === null || this.desired === null) return null;
    if (now - this.fallbackAt < this.probeDelayMs) return null;
    this.fallbackAt = null;
    this.armScoped(now);
    return { kind: "scoped", topic: this.topic, scope: this.desired, reason: "reprobe" };
  }

  /** Reported-only block for the config report and the local state file. */
  report(): TelemetryScopeReport {
    const out: TelemetryScopeReport = { topic: this.topic, scoped: this.scoped };
    if (this.desired) {
      out.organizationId = this.desired.organizationId;
      out.workspaceId = this.desired.workspaceId;
    }
    if (this.fallbackAt !== null) {
      out.fallback = { since: this.fallbackAt, count: this.fallbackCount };
    }
    return out;
  }

  /** Arm the scoped topic and restart the measurement cycle from here. */
  private armScoped(now: number): void {
    this.scoped = true;
    this.runCycles = 0;
    this.publishesSinceArm = 0;
    // Only meaningful while connected; a connect will set it otherwise.
    if (this.cycleStartedAt !== null) this.cycleStartedAt = now;
  }
}
