import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DiskManager } from "../src/recording/disk.js";
import { cleanup, tempHome } from "./helpers.js";

let home: string;
let root: string;
beforeEach(() => {
  home = tempHome();
  root = join(home, "recordings");
});
afterEach(() => cleanup(home));

/** Create a fake closed segment of `size` bytes with a deterministic mtime. */
function seg(session: string, name: string, size: number, mtimeSec: number): string {
  const dir = join(root, "telemetry", session);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(size, 1));
  utimesSync(path, mtimeSec, mtimeSec);
  return path;
}

describe("DiskManager", () => {
  it("evicts oldest closed segments first until under maxBytes", async () => {
    const oldest = seg("s1", "seg-1-00000.jsonl.gz", 1000, 100);
    const middle = seg("s1", "seg-2-00001.jsonl.gz", 1000, 200);
    const newest = seg("s2", "seg-3-00000.jsonl.gz", 1000, 300);

    const dm = new DiskManager({
      root,
      retention: { maxBytes: 2000, minFreeBytes: 0 },
      freeBytes: async () => 10_000_000,
    });
    await dm.enforce();

    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(newest)).toBe(true);
    expect(dm.stats()).toMatchObject({ droppedSegments: 1, backlogSegments: 2, backlogBytes: 2000 });
  });

  it("evicts for the min-free floor even under quota", async () => {
    const oldest = seg("s1", "seg-1-00000.jsonl.gz", 1000, 100);
    seg("s1", "seg-2-00001.jsonl.gz", 1000, 200);

    let free = 500; // below the floor until one eviction "frees" space
    const dm = new DiskManager({
      root,
      retention: { maxBytes: 1_000_000, minFreeBytes: 1000 },
      freeBytes: async () => free,
    });
    await dm.enforce();

    expect(existsSync(oldest)).toBe(false);
    expect(dm.stats().droppedSegments).toBe(1);
  });

  it("never touches the active plain segment or unknown files", async () => {
    const active = seg("s1", "seg-9-00009.jsonl", 5000, 50); // plain jsonl = active
    const counter = join(root, "counters.json");
    const closed = seg("s1", "seg-1-00000.jsonl.gz", 1000, 100);

    const dm = new DiskManager({
      root,
      retention: { maxBytes: 100, minFreeBytes: 0 }, // hopelessly over quota
      freeBytes: async () => 10_000_000,
    });
    await dm.enforce();

    expect(existsSync(active)).toBe(true); // active survives even though quota is blown
    expect(existsSync(closed)).toBe(false);
    expect(existsSync(counter)).toBe(true); // dropped counter persisted
  });

  it("persists droppedSegments across restarts", async () => {
    seg("s1", "seg-1-00000.jsonl.gz", 1000, 100);
    const dm1 = new DiskManager({
      root,
      retention: { maxBytes: 100, minFreeBytes: 0 },
      freeBytes: async () => 10_000_000,
    });
    await dm1.enforce();
    expect(dm1.stats().droppedSegments).toBe(1);

    const dm2 = new DiskManager({
      root,
      retention: { maxBytes: 100, minFreeBytes: 0 },
      freeBytes: async () => 10_000_000,
    });
    expect(dm2.stats().droppedSegments).toBe(1); // reloaded from counters.json
  });

  it("respects setActivePath registration", async () => {
    const protectedGz = seg("s1", "seg-1-00000.jsonl.gz", 1000, 100);
    const other = seg("s1", "seg-2-00001.jsonl.gz", 1000, 200);

    const dm = new DiskManager({
      root,
      retention: { maxBytes: 100, minFreeBytes: 0 },
      freeBytes: async () => 10_000_000,
    });
    dm.setActivePath("telemetry", protectedGz);
    await dm.enforce();

    expect(existsSync(protectedGz)).toBe(true);
    expect(existsSync(other)).toBe(false);
  });

  it("reports backlog without evicting when within limits", async () => {
    seg("s1", "seg-1-00000.jsonl.gz", 1000, 100);
    seg("s1", "seg-2-00001.jsonl.gz", 2000, 200);
    const dm = new DiskManager({
      root,
      retention: { maxBytes: 1_000_000, minFreeBytes: 0 },
      freeBytes: async () => 10_000_000,
    });
    await dm.enforce();
    expect(dm.stats()).toEqual({ backlogSegments: 2, backlogBytes: 3000, droppedSegments: 0 });
  });

  it("handles a missing tree gracefully", async () => {
    const dm = new DiskManager({
      root,
      retention: { maxBytes: 100, minFreeBytes: 0 },
      freeBytes: async () => 10_000_000,
    });
    await dm.enforce();
    expect(dm.stats()).toEqual({ backlogSegments: 0, backlogBytes: 0, droppedSegments: 0 });
    expect(existsSync(root)).toBe(false); // enforce never creates the tree
  });
});
