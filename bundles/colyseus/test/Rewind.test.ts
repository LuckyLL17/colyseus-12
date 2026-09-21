import assert from "assert";

import { schema, t, MapSchema, type SchemaType } from "@colyseus/schema";
import { Rewind, RewindView, Room } from "@colyseus/core";

const Entity = schema({
  x: t.number().default(0),
  y: t.number().default(0),
});
type Entity = SchemaType<typeof Entity>;

// A fresh Rewind per test (keyed by a throwaway room object), with one tracked
// entity. Records are driven manually (no simulation loop) so timing is exact.
function setup(maxRewindMs = 200) {
  const room = {};
  const rewind = Rewind.get(room, { maxRewindMs });
  const players = new MapSchema<Entity>();
  const e = new Entity();
  players.set("a", e);
  rewind.attachAll(players, { fields: ["x", "y"] });
  return { rewind, e };
}

describe("Rewind: at() / lastSeenBy", () => {
  it("at() interpolates linearly within the retained window", () => {
    const { rewind, e } = setup();
    e.x = 0; e.y = 0; rewind.record(100);
    e.x = 10; e.y = 20; rewind.record(200);

    const view = rewind.at(150);
    assert.equal(view.time, 150);
    assert.ok(Math.abs(view.value(e, "x") - 5) < 1e-6, `x@150 ≈ 5, got ${view.value(e, "x")}`);
    assert.ok(Math.abs(view.value(e, "y") - 10) < 1e-6, `y@150 ≈ 10, got ${view.value(e, "y")}`);
  });

  it("at(0) is the live fallback (newest sample) — clock not synced", () => {
    const { rewind, e } = setup();
    e.x = 0; rewind.record(100);
    e.x = 10; rewind.record(200);

    const view = rewind.at(0);
    assert.equal(view.time, 200, "clamps to lastRecordedAt");
    assert.equal(view.value(e, "x"), 10, "reads the newest recorded position");
  });

  it("at() clamps a too-old time up to the maxRewindMs window", () => {
    const { rewind, e } = setup(200);
    e.x = 0; rewind.record(100);
    e.x = 10; rewind.record(400); // newest=400 → window starts at 400-200=200

    assert.equal(rewind.at(150).time, 200, "150 < (400-200) → clamped to 200");
    assert.equal(rewind.at(999).time, 400, "future time → clamped to newest");
  });

  it("at() falls back to the live field for an untracked entity (no history)", () => {
    const { rewind } = setup();
    const orphan = new Entity();
    orphan.x = 42;
    assert.equal(rewind.at(100).value(orphan, "x"), 42);
  });

  it("read() batches into an object shaped by the caller's field list", () => {
    const { rewind, e } = setup();
    e.x = 0; e.y = 0; rewind.record(100);
    e.x = 10; e.y = 20; rewind.record(200);

    const pos = rewind.at(150).read(e, ["x", "y"]);
    assert.ok(Math.abs(pos.x - 5) < 1e-6);
    assert.ok(Math.abs(pos.y - 10) < 1e-6);
    assert.deepEqual(Object.keys(pos), ["x", "y"], "shape = exactly the listed fields");

    // Single-field shape — no assumption that x/y/z all exist.
    const onlyY = rewind.at(150).read(e, ["y"]);
    assert.deepEqual(Object.keys(onlyY), ["y"]);
  });

  it("read(out) fills + returns a reused scratch, leaving extra properties untouched", () => {
    const { rewind, e } = setup();
    e.x = 0; e.y = 0; rewind.record(100);
    e.x = 10; e.y = 20; rewind.record(200);

    const scratch = { x: -1, y: -1, alive: true };
    const out = rewind.at(150).read(e, ["x", "y"], scratch);
    assert.equal(out, scratch, "returns the same object");
    assert.ok(Math.abs(scratch.x - 5) < 1e-6);
    assert.ok(Math.abs(scratch.y - 10) < 1e-6);
    assert.equal(scratch.alive, true, "non-listed fields untouched");
  });

  it("at() re-aims the Rewind's internal default view — zero alloc, zero setup", () => {
    const { rewind, e } = setup();
    e.x = 0; rewind.record(100);
    e.x = 10; rewind.record(200);

    const a = rewind.at(100);
    assert.equal(a.value(e, "x"), 0);
    const b = rewind.at(200);
    assert.equal(a, b, "no `out` → the same internal instance, re-aimed");
    assert.equal(b.time, 200);
    assert.equal(b.value(e, "x"), 10);
  });

  it("pass `out` to hold a second, independent view (compare perspectives)", () => {
    const { rewind, e } = setup();
    e.x = 0; rewind.record(100);
    e.x = 10; rewind.record(200);

    const mine = rewind.at(100, new RewindView());
    const def = rewind.at(200);                  // internal default
    assert.notEqual(mine, def);
    assert.equal(mine.time, 100, "unaffected by later default re-aims");
    assert.equal(def.time, 200);
    assert.equal(mine.value(e, "x"), 0);
    assert.equal(def.value(e, "x"), 10);

    rewind.bindRenderTime(() => 100);
    assert.equal(rewind.lastSeenBy("a", mine), mine, "lastSeenBy passes `out` through");
    assert.equal(mine.value(e, "x"), 0);
  });

  it("an un-aimed scratch view fails loudly on read", () => {
    const fresh = new RewindView();
    const e = new Entity();
    assert.throws(() => fresh.value(e, "x"), /not aimed/);
  });

  it("lastSeenBy throws until a render-time resolver is bound", () => {
    const { rewind } = setup();
    assert.throws(() => rewind.lastSeenBy("a"), /framework input API/);
  });

  it("lastSeenBy resolves the bound per-session render time", () => {
    const { rewind, e } = setup();
    e.x = 0; rewind.record(100);
    e.x = 10; rewind.record(200);

    rewind.bindRenderTime((sid) => (sid === "a" ? 150 : 0));
    assert.ok(Math.abs(rewind.lastSeenBy("a").value(e, "x") - 5) < 1e-6);
    // Unknown session → 0 → live fallback (newest).
    assert.equal(rewind.lastSeenBy("zzz").value(e, "x"), 10);
  });
});

// A missing input API still fails loudly at first use — a silent 0 stamp would
// read live positions and quietly disable lag comp. Stamping itself is now
// auto-enabled from the rewind attachments (no `renderTime` flag to forget), so
// the only remaining wiring error is never calling defineInput at all.
describe("Rewind: lastSeenBy misconfiguration (Room wiring)", () => {
  it("throws when the room has no input API (never called defineInput)", () => {
    class NoInputRoom extends Room {
      rewind = this.allowRewindState();
    }
    const room = new NoInputRoom();
    assert.throws(() => room.rewind.lastSeenBy("any"), /inputs = this\.defineInput/);
  });

  it("configured room: an unknown/unstamped client is NOT an error (live fallback)", () => {
    class OkRoom extends Room {
      inputs = this.defineInput(Entity);   // stamping auto-enables when you rewind a group
      rewind = this.allowRewindState();
    }
    const room = new OkRoom();
    assert.doesNotThrow(() => room.rewind.lastSeenBy("nobody"));
  });
});

// Per-attach `mode` picks the rewind TIMELINE: snapshot → renderTime stamp,
// reckon → reckonTime stamp. Both resolvers feed `value()`, which picks per
// field via the covering attach-group's history.
const Mob = schema({
  x: t.number().default(0),
  hp: t.number().default(0),
});
type Mob = SchemaType<typeof Mob>;

describe("Rewind: per-attach mode (timeline)", () => {
  it("mode:'reckon' group reads at reckonTime; mode:'snapshot' at renderTime", () => {
    const rewind = Rewind.get({}, { maxRewindMs: 500 });
    const reckonCol = new MapSchema<Entity>();
    const snapCol = new MapSchema<Entity>();
    const re = new Entity(); reckonCol.set("r", re);
    const se = new Entity(); snapCol.set("s", se);
    rewind.attachAll(reckonCol, { fields: ["x"], mode: "reckon" });
    rewind.attachAll(snapCol, { fields: ["x"] });   // default snapshot

    re.x = 0; se.x = 0; rewind.record(100);
    re.x = 100; se.x = 100; rewind.record(200);

    rewind.bindRenderTime(() => 120);   // snapshot timeline
    rewind.bindReckonTime(() => 180);   // reckon timeline (≈ closer to "now")
    const seen = rewind.lastSeenBy("any");
    assert.ok(Math.abs(seen.value(re, "x") - 80) < 1e-6, `reckon entity @180 → x≈80, got ${seen.value(re, "x")}`);
    assert.ok(Math.abs(seen.value(se, "x") - 20) < 1e-6, `snapshot entity @120 → x≈20, got ${seen.value(se, "x")}`);
  });

  it("same collection attached twice (disjoint fields) puts each field on its own timeline", () => {
    const rewind = Rewind.get({}, { maxRewindMs: 500 });
    const col = new MapSchema<Mob>();
    const m = new Mob(); col.set("m", m);
    rewind.attachAll(col, { fields: ["x"], mode: "reckon" });
    rewind.attachAll(col, { fields: ["hp"], mode: "snapshot" });

    m.x = 0; m.hp = 0; rewind.record(100);
    m.x = 100; m.hp = 100; rewind.record(200);

    rewind.bindRenderTime(() => 120);
    rewind.bindReckonTime(() => 180);
    const seen = rewind.lastSeenBy("any");
    assert.ok(Math.abs(seen.value(m, "x") - 80) < 1e-6, `x (reckon group) @180 → 80, got ${seen.value(m, "x")}`);
    assert.ok(Math.abs(seen.value(m, "hp") - 20) < 1e-6, `hp (snapshot group) @120 → 20, got ${seen.value(m, "hp")}`);
  });
});

describe("Rewind: record() commit order", () => {
  it("commits monotonically — duplicate and out-of-order frames are dropped", () => {
    const { rewind, e } = setup();
    e.x = 1;
    assert.equal(rewind.record(100), true, "first frame commits");
    e.x = 2;
    assert.equal(rewind.record(100), false, "the same frame twice is a duplicate — dropped");
    assert.equal(rewind.lastRecordedAt, 100);
    e.x = 3;
    assert.equal(rewind.record(50), false, "an older frame is late — dropped (commit order stays server-frame order)");
    assert.equal(rewind.lastRecordedAt, 100);
    e.x = 4;
    assert.equal(rewind.record(200), true);

    // The dropped frames never entered history: 100→200 lerps 1→4 (not 1→2→3→4).
    const view = rewind.at(150);
    assert.ok(Math.abs(view.value(e, "x") - 2.5) < 1e-6, `x@150 ≈ 2.5, got ${view.value(e, "x")}`);
    assert.equal(view.debug!.from, 100);
    assert.equal(view.debug!.to, 200);
  });
});

describe("Rewind: strict aim (tryAt / tryLastSeenBy)", () => {
  it("tryAt within the window aims like at()", () => {
    const { rewind, e } = setup();
    e.x = 0; rewind.record(100);
    e.x = 10; rewind.record(200);

    const aim = rewind.tryAt(150);
    assert.ok(aim.ok);
    if (aim.ok) {
      assert.equal(aim.view.time, 150);
      assert.ok(Math.abs(aim.view.value(e, "x") - 5) < 1e-6);
    }
  });

  it("tryAt(0) rejects not-synced (the lenient live fallback made observable)", () => {
    const { rewind } = setup();
    rewind.record(100);
    const aim = rewind.tryAt(0);
    assert.ok(!aim.ok);
    if (!aim.ok) assert.equal(aim.reason, "not-synced");
  });

  it("tryAt rejects a stamp older than the retention window (too-old) — no arbitrary old state", () => {
    const { rewind } = setup(200);
    rewind.record(100);
    rewind.record(400);   // window floor = 400 − 200 = 200

    const aim = rewind.tryAt(150);
    assert.ok(!aim.ok);
    if (!aim.ok) {
      assert.equal(aim.reason, "too-old");
      assert.equal(aim.bound, 200, "the depth floor that rejected it");
      assert.equal(aim.time, 150);
    }
    // …while the lenient at(150) still silently clamps (existing call style preserved).
    assert.equal(rewind.at(150).time, 200);
  });

  it("tryAt rejects a future stamp (client clock skew)", () => {
    const { rewind } = setup();
    rewind.record(100);
    rewind.record(400);

    // No bound now → the newest record is the ceiling.
    const skewed = rewind.tryAt(401);
    assert.ok(!skewed.ok);
    if (!skewed.ok) assert.equal(skewed.reason, "future");

    // A bound now lifts the ceiling to the true processing instant.
    rewind.bindNow(() => 450);
    assert.ok(rewind.tryAt(450).ok);
    const ahead = rewind.tryAt(451);
    assert.ok(!ahead.ok);
    if (!ahead.ok) {
      assert.equal(ahead.reason, "future");
      assert.equal(ahead.bound, 450);
    }
  });

  it("tryLastSeenBy rejects a late input's renderTime instead of clamping it", () => {
    const { rewind, e } = setup(200);
    e.x = 0; rewind.record(100);
    e.x = 10; rewind.record(400);   // window floor = 200

    rewind.bindRenderTime((sid) => (sid === "late" ? 150 : 250));
    const late = rewind.tryLastSeenBy("late");
    assert.ok(!late.ok);
    if (!late.ok) assert.equal(late.reason, "too-old");

    const fresh = rewind.tryLastSeenBy("fresh");
    assert.ok(fresh.ok);
    if (fresh.ok) assert.ok(Math.abs(fresh.view.value(e, "x") - 5) < 1e-6);
  });

  it("tryLastSeenBy rejects an unstamped client (not-synced) — lenient lastSeenBy still falls back live", () => {
    const { rewind } = setup();
    rewind.record(100);
    rewind.bindRenderTime(() => 0);

    const aim = rewind.tryLastSeenBy("syncing");
    assert.ok(!aim.ok);
    if (!aim.ok) assert.equal(aim.reason, "not-synced");
    assert.doesNotThrow(() => rewind.lastSeenBy("syncing"));
  });

  it("tryLastSeenBy throws without the input API, like lastSeenBy", () => {
    const { rewind } = setup();
    assert.throws(() => rewind.tryLastSeenBy("any"), /framework input API/);
  });

  it("a reckon-only room validates the reckon stamp (unstamped → not-synced)", () => {
    const rewind = Rewind.get({}, { maxRewindMs: 500 });
    const col = new MapSchema<Entity>();
    const e = new Entity(); col.set("e", e);
    rewind.attachAll(col, { fields: ["x"], mode: "reckon" });
    e.x = 0; rewind.record(100);
    e.x = 100; rewind.record(500);

    rewind.bindRenderTime(() => 0);    // no snapshot groups → unused
    rewind.bindReckonTime((sid) => (sid === "stamped" ? 450 : 0));

    const unstamped = rewind.tryLastSeenBy("unstamped");
    assert.ok(!unstamped.ok);
    if (!unstamped.ok) assert.equal(unstamped.reason, "not-synced");

    const stamped = rewind.tryLastSeenBy("stamped");
    assert.ok(stamped.ok);
    if (stamped.ok) {
      const r = stamped.view.tryValue(e, "x");
      assert.ok(r.ok);
      if (r.ok) assert.ok(Math.abs(r.value - 87.5) < 1e-6, `x@450 ≈ 87.5, got ${r.ok ? r.value : "rejected"}`);
    }
  });
});

describe("Rewind: strict reads enforce the per-attach depth (maxDepthMs)", () => {
  it("a group with maxDepthMs < retention rejects reads deeper than the depth", () => {
    const rewind = Rewind.get({}, { maxRewindMs: 500 });
    const col = new MapSchema<Entity>();
    const e = new Entity(); col.set("e", e);
    rewind.attachAll(col, { fields: ["x"], maxDepthMs: 100 });   // keep 500ms, allow 100ms deep

    e.x = 0; rewind.record(100);
    e.x = 100; rewind.record(500);   // depth floor = 500 − 100 = 400

    const view = rewind.at(450);
    const ok = view.tryValue(e, "x");
    assert.ok(ok.ok);
    if (ok.ok) assert.ok(Math.abs(ok.value - 87.5) < 1e-6);

    const deep = rewind.at(350).tryValue(e, "x");
    assert.ok(!deep.ok);
    if (!deep.ok) {
      assert.equal(deep.reason, "too-old");
      assert.equal(deep.bound, 400);
      assert.equal(deep.field, "x");
    }
    // The lenient read at the same aim still clamps and serves (existing style preserved).
    assert.ok(Math.abs(rewind.at(350).value(e, "x") - 62.5) < 1e-6);
  });

  it("maxDepthMs / maxRewindMs accept a per-entity fn — depth chosen per entity type", () => {
    const Npc = schema({ kind: t.number().default(0), x: t.number().default(0) });
    type Npc = SchemaType<typeof Npc>;
    const rewind = Rewind.get({}, { maxRewindMs: 500 });
    const npcs = new MapSchema<Npc>();
    const boss = new Npc(); boss.kind = 1; npcs.set("boss", boss);
    const grunt = new Npc(); grunt.kind = 0; npcs.set("grunt", grunt);
    rewind.attachAll(npcs, { fields: ["x"], maxDepthMs: (e) => (e.kind === 1 ? 50 : 200) });

    boss.x = 0; grunt.x = 0; rewind.record(100);
    boss.x = 100; grunt.x = 100; rewind.record(500);

    const view = rewind.at(425);   // 75ms back: inside the grunt's 200ms depth, past the boss's 50ms
    assert.ok(view.tryValue(grunt, "x").ok);
    const b = view.tryValue(boss, "x");
    assert.ok(!b.ok);
    if (!b.ok) {
      assert.equal(b.reason, "too-old");
      assert.equal(b.bound, 450, "boss depth floor = 500 − 50");
    }
  });

  it("within depth but older than the oldest retained frame → no-data (missing frames)", () => {
    const rewind = Rewind.get({}, { maxRewindMs: 500 });
    const col = new MapSchema<Entity>();
    const e = new Entity(); col.set("e", e);
    rewind.attachAll(col, { fields: ["x"] });

    e.x = 1; rewind.record(100);
    const late = new Entity(); late.x = 9; col.set("late", late);   // spawns at 500
    e.x = 2; rewind.record(500);

    const r = rewind.at(450).tryValue(late, "x");
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.equal(r.reason, "no-data", "450 is within the 500ms depth but predates the entity's first frame");
      assert.equal(r.bound, 500, "the oldest retained frame");
    }
    // …and the lenient read would have silently served frame 500's value.
    assert.equal(rewind.at(450).value(late, "x"), 9);
  });

  it("untracked entity or field → untracked", () => {
    const { rewind, e } = setup();
    e.x = 1; rewind.record(100);

    const orphan = new Entity();
    const a = rewind.at(100).tryValue(orphan, "x");
    assert.ok(!a.ok);
    if (!a.ok) assert.equal(a.reason, "untracked");

    assert.ok(rewind.at(100).tryValue(e, "y").ok, "y IS tracked by setup()");
    const c = rewind.at(100).tryValue(e, "z" as never);   // "z" is not a tracked field
    assert.ok(!c.ok);
    if (!c.ok) assert.equal(c.reason, "untracked");
  });

  it("a view aimed at the live fallback rejects not-synced / future on strict reads", () => {
    const { rewind, e } = setup();
    e.x = 1; rewind.record(100);
    e.x = 2; rewind.record(200);
    rewind.bindNow(() => 250);

    const unsynced = rewind.at(0).tryValue(e, "x");   // raw stamp 0 (clock not synced)
    assert.ok(!unsynced.ok);
    if (!unsynced.ok) assert.equal(unsynced.reason, "not-synced");

    const skewed = rewind.at(300).tryValue(e, "x");   // raw stamp past the bound now
    assert.ok(!skewed.ok);
    if (!skewed.ok) {
      assert.equal(skewed.reason, "future");
      assert.equal(skewed.bound, 250);
    }
  });

  it("tryRead batches strictly — the first rejecting field fails with its name", () => {
    const rewind = Rewind.get({}, { maxRewindMs: 500 });
    const col = new MapSchema<Entity>();
    const e = new Entity(); col.set("e", e);
    rewind.attachAll(col, { fields: ["x"], maxDepthMs: 100 });
    rewind.attachAll(col, { fields: ["y"] });   // default depth = retention (500)

    e.x = 0; e.y = 0; rewind.record(100);
    e.x = 10; e.y = 20; rewind.record(500);

    const ok = rewind.at(450).tryRead(e, ["x", "y"]);
    assert.ok(ok.ok);
    if (ok.ok) {
      assert.ok(Math.abs(ok.value.x - 8.75) < 1e-6, `x@450 ≈ 8.75, got ${ok.value.x}`);
      assert.ok(Math.abs(ok.value.y - 17.5) < 1e-6, `y@450 ≈ 17.5, got ${ok.value.y}`);
    }

    const deep = rewind.at(350).tryRead(e, ["y", "x"]);   // y ok (500 deep), x rejects (100 deep)
    assert.ok(!deep.ok);
    if (!deep.ok) {
      assert.equal(deep.reason, "too-old");
      assert.equal(deep.field, "x");
    }
  });

  it("tryValueAt is the strict single-target one-shot (mirrors valueAt)", () => {
    const { rewind, e } = setup(200);
    e.x = 0; rewind.record(100);
    e.x = 10; rewind.record(200);

    const ok = rewind.tryValueAt(e, 150, "x");
    assert.ok(ok.ok);
    if (ok.ok) assert.ok(Math.abs(ok.value - 5) < 1e-6);

    const unsynced = rewind.tryValueAt(e, 0, "x");
    assert.ok(!unsynced.ok);
    if (!unsynced.ok) assert.equal(unsynced.reason, "not-synced");

    const noFrames = rewind.tryValueAt(e, 50, "x");   // within the window, before the first frame
    assert.ok(!noFrames.ok);
    if (!noFrames.ok) assert.equal(noFrames.reason, "no-data");

    const orphan = new Entity();
    const untracked = rewind.tryValueAt(orphan, 150, "x");
    assert.ok(!untracked.ok);
    if (!untracked.ok) assert.equal(untracked.reason, "untracked");

    // …and the lenient single-target style is untouched.
    assert.equal(rewind.valueAt(e, 150, "x"), 5);
  });
});

describe("Rewind: debug output names the history frame actually used", () => {
  it("debug reports the bracketing frames of an interpolated read", () => {
    const { rewind, e } = setup();
    e.x = 0; rewind.record(100);
    e.x = 10; rewind.record(200);

    const view = rewind.at(150);
    assert.equal(view.debug, undefined, "no read yet");
    view.value(e, "x");

    const d = view.debug!;
    assert.equal(d.field, "x");
    assert.equal(d.requested, 150);
    assert.equal(d.at, 150);
    assert.equal(d.from, 100, "the frame at-or-before the sample");
    assert.equal(d.to, 200, "the next frame");
    assert.equal(d.interpolated, true);
    assert.equal(d.live, false);
    assert.match(view.describe(), /lerp frames \[100\.\.200\] @ 150/);
  });

  it("debug reports the single frame a clamped read landed on", () => {
    const { rewind, e } = setup();
    e.x = 0; rewind.record(100);
    e.x = 10; rewind.record(200);

    const view = rewind.at(999);   // clamped to the newest frame
    view.value(e, "x");
    const d = view.debug!;
    assert.equal(d.requested, 999);
    assert.equal(d.at, 200);
    assert.equal(d.from, 200);
    assert.equal(d.to, 200);
    assert.equal(d.interpolated, false);
    assert.match(view.describe(), /frame 200/);
  });

  it("debug marks a live (untracked) fallback and a strict rejection", () => {
    const { rewind, e } = setup(200);
    e.x = 0; rewind.record(100);
    e.x = 10; rewind.record(400);   // depth floor = 400 − 200 = 200

    const orphan = new Entity();
    const view = rewind.at(300);
    view.value(orphan, "x");
    assert.equal(view.debug!.live, true);
    assert.match(view.describe(), /LIVE, untracked/);

    const rej = rewind.at(150).tryValue(e, "x");   // 150 < 200 → too-old
    assert.ok(!rej.ok);
    assert.equal(view.debug!.reason, "too-old");
    assert.match(view.describe(), /REJECTED too-old/);
  });
});
