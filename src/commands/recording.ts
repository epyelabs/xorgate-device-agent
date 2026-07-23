/**
 * `xorgate recording <subcommand>` — on-device recording maintenance
 * (offline recording plan, Phase 6.5).
 *
 *   reset-counters   Zero the persistent droppedSegments counter.
 *
 * The counter (recordings/counters.json) is cumulative for the life of the
 * tree — deliberate loss accounting — but a redeployed or repurposed device
 * shouldn't carry old drill/field losses forever. The write is atomic
 * (atomicWriteJson) and the running agent re-reads the file on every status
 * tick (DiskManager.stats), so the reset shows up in state.json / the live
 * payload within ~5 s, no restart needed. Racing an in-flight eviction is
 * harmless: both writers are atomic, last one wins, and a lost reset would be
 * re-run by the operator anyway.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../lib/atomicWrite.js";
import { recordingsRoot } from "../recording/config.js";

export async function recordingCommand(args: string[]): Promise<void> {
  const sub = args.find((a) => !a.startsWith("-"));
  if (sub !== "reset-counters") {
    console.error(
      `usage: xorgate recording reset-counters   (zero the droppedSegments counter)`,
    );
    process.exitCode = 1;
    return;
  }

  const root = recordingsRoot();
  const counterPath = join(root, "counters.json");
  if (!existsSync(root)) {
    console.log("no recordings tree — counters are already 0");
    return;
  }
  atomicWriteJson(counterPath, { v: 1, droppedSegments: 0 });
  console.log("✓ droppedSegments reset to 0");
  console.log("  the agent reflects it in state/telemetry within ~5 s (no restart needed)");
}
