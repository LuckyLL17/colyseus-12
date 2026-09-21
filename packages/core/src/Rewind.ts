import { $values, type MapSchema, type ArraySchema, type SetSchema } from "@colyseus/schema";
import { $METADATA } from "./utils/Utils.ts";
import { debugRewind } from "./Debug.ts";

const DEFAULT_MAX_REWIND_MS = 500;
/** Default FRAME-depth wall: unbounded (the time window alone bounds history). */
const DEFAULT_MAX_REWIND_FRAMES = Infinity;
/** Ring-sizing fallback when the record cadence isn't supplied (manual `record(now)`
 *  without a hint). `allowRewindState` feeds the real sim interval, so this only
 *  matters for ad-hoc manual use. */
const DEFAULT_SAMPLE_INTERVAL_MS = 1000 / 60;
/** Extra ring slots over the configured window — the interpolating bracket
 *  always sits INSIDE the retained span, and a tick jitter can't evict the
 *  boundary sample the depth wall is measured against. */
const RING_SLACK = 4;

// Hot record() path: dense `$values[index]` is ~15× faster than `inst[fieldName]`; entity symbol prop ~8× faster than a WeakMap.
/** Per-entity history, under this private symbol ON the entity. Symbol-keyed so it's
 *  invisible to Object.keys / `assign` / `clone`, and GC'd with the entity. */
const $HISTORY = Symbol("rewind.history");

/** Keys of T whose value type is `number` — the only rewindable fields. */
type NumericKeys<T> = { [K in keyof T]-?: T[K] extends number ? K : never }[keyof T] & string;
/** A Colyseus collection whose element type is `E`. Inferring `E` from the live
 *  collection the caller passes is what lets `fields` narrow with zero state-type
 *  plumbing. */
type Collection<E> = MapSchema<E> | ArraySchema<E> | SetSchema<E>;

/** How `valueAt` reconstructs a value between recorded samples. */
export type RewindInterp = "linear" | "step";

/** The lag-comp TIMELINE a strict read resolves a stamp on. Mirrors
 *  {@link RewindMode}: `"snapshot"` (default) reads at the client renderTime,
 *  `"reckon"` at its reckonTime. */
export type RewindResolveMode = "snapshot" | "reckon";

/**
 * Why a STRICT rewind read ({@link Rewind.resolveValueAt} /
 * {@link Rewind.resolveAt} / {@link Rewind.resolveSeenBy}) refused to return a
 * rewound value. Observable by design: the caller decides whether the refusal
 * means "miss", "judge live", or "drop the hit" — the strict path never clamps
 * silently or reads arbitrary older state.
 *
 * - `not-tracked` — entity/field isn't in any attach group. The loose
 *   APIs ({@link Rewind.at}) fall back to the live field; the strict APIs
 *     refuse instead (a rewound verdict over untracked state would be a lie).
 * - `not-synced` — the client stamp is `≤ 0` / unknown session: its clock is
 *   still syncing or the frame carried no stamp (skew/uninitialized).
 * - `ahead-of-server` — the stamp is NEWER than the newest recorded server
 *   frame (a fast/skewed client clock). Reading forward is extrapolation, not
 *   rewind; the caller must reject or judge live.
 * - `rewind-too-far-time` — `newest − stamp` exceeds the group's
 *   `maxRewindMs` for this entity type.
 * - `rewind-too-far-frames` — the integer frame depth exceeds the group's
 *   `maxRewindFrames` for this entity type.
 * - `history-gap` — the stamp is inside the configured window but older than
 *   the oldest RETAINED sample: the frames covering it were already evicted
 *   (a burst/eviction the ring didn't have room for), so no honest read exists.
 */
export type RewindRejectReason =
  | "not-tracked"
  | "not-synced"
  | "ahead-of-server"
  | "rewind-too-far-time"
  | "rewind-too-far-frames"
  | "history-gap";

/** Why {@link RewindVerdict.submit} refused to enqueue a result. */
export type RewindCommitRejectReason =
  | "rejected-verdict" // submit was called on a rejection — only ok verdicts commit
  | "frame-stale";     // the verdict belongs to a previous server frame (submit after the next record())

/** One recorded sample's identity: the monotonic server-frame index
 *  {@link Rewind.record} assigned it and the server time it was recorded at. */
export interface RewindFrameInfo {
  readonly frame: number;
  readonly time: number;
}

/**
 * Observable trace of one strict rewind read — which retained frame(s) the
 * value actually came from, how deep the read went, and the walls it stayed
 * inside. {@link describe} renders the one-line `colyseus:rewind` debug form;
 * every field is also machine-readable for your own logging.
 */
export interface RewindDebug {
  /** Field this trace is for (a multi-field verdict carries one trace per field
   *  in {@link RewindVerdict.fields}). */
  readonly field: string;
  /** Raw client stamp requested. */
  readonly requestedTime: number;
  /** Server time actually read at (identical to the request on the strict
   *  path — a strict read never clamps). */
  readonly resolvedTime: number;
  /** Timeline the stamp was resolved on. */
  readonly timeline: RewindResolveMode;
  /** `true` when no direct client stamp existed and the reckon time was
   *  RECONSTRUCTED as the stamp↔arrival midpoint (inherits the client's
   *  RTT-estimate error; a direct stamp is the accurate path). */
  readonly estimated: boolean;
  /** The retained sample(s) used: one for an exact frame hit, two for the
   *  interpolation bracket (older → newer). */
  readonly usedFrames: readonly RewindFrameInfo[];
  /** `"exact"` hit a recorded sample; otherwise the group's interp mode. */
  readonly method: "exact" | RewindInterp;
  /** `newest − resolvedTime`. */
  readonly depthMs: number;
  /** Retained samples strictly newer than the resolved instant — integer
   *  frame depth, 0 at the newest frame. */
  readonly depthFrames: number;
  readonly maxRewindMs: number;
  readonly maxRewindFrames: number;
  /** Number of samples currently retained for this entity/field. */
  readonly retainedFrames: number;
  /** The stamped frame is ≥ two frames behind the newest — a LATE input
   *  (arrived later than the normal one-frame lag-compensation span), still
   *  resolved exactly rather than dropped. */
  readonly late: boolean;
  /** One-line human summary, as emitted under `DEBUG=colyseus:rewind`. */
  describe(): string;
}

/**
 * A successful strict rewind read. `value` is the field value (single-field)
 * or an object shaped by the requested `fields` ({@link Rewind.resolveAt}).
 * The verdict is valid for submission ONLY during the server frame that
 * produced it ({@link serverFrame}) — submit across the next
 * {@link Rewind.record} boundary returns `frame-stale`.
 */
export interface RewindVerdict<T = number> {
  readonly ok: true;
  readonly value: T;
  readonly serverFrame: number;
  /** See {@link RewindDebug.late}. Multi-field: true when ANY field is late. */
  readonly late: boolean;
  /** Max per-field frame depth (0 = read at the newest frame). */
  readonly frameDepth: number;
  /** `true` when an identical (entity, field(s), stamp, timeline) read was
   *  already resolved THIS server frame — the same result is returned
   *  instead of recomputing (same-frame duplicate computation is idempotent). */
  readonly duplicate: boolean;
  /** Representative trace (the only field for single reads; the first field
   *  for multi-field reads). */
  readonly debug: RewindDebug;
  /** Multi-field only: one trace per resolved field. */
  readonly fields?: Readonly<Record<string, RewindDebug>>;
  /**
   * Enqueue this verdict's hit-test RESULT (`payload`: damage, a kill flag,
   * whatever your sim produces) on the per-frame, FIFO commit ledger. Entries
   * are delivered to the room in server-FRAME order (older frame first, then
   * insertion order within the frame) at the next {@link Rewind.record}
   * boundary — via the `onCommit` option or {@link Rewind.takeCommitted}.
   * Idempotent within a frame: re-submitting a duplicate verdict returns the
   * same entry (its `duplicate` is set) instead of enqueuing twice.
   */
  submit<P>(payload: P): RewindCommitResult<P>;
}

/** A refused strict read — {@link reason} is machine-switchable,
 *  {@link message} carries the timestamps/limits for logs. `field` names the
 *  first field that failed on a multi-field read. */
export interface RewindRejection {
  readonly ok: false;
  readonly reason: RewindRejectReason;
  readonly field?: string;
  readonly message: string;
  readonly requestedTime: number;
  /** Newest/oldest retained server time AT REJECT TIME (-1 pre-record). */
  readonly newestTime: number;
  readonly oldestTime: number;
  readonly serverFrame: number;
}

/** Discriminated result of the strict APIs. */
export type RewindResult<T = number> = RewindVerdict<T> | RewindRejection;

/** One ordered, frame-tagged ledger entry handed to userland at a frame
 *  boundary. `debug` is the resolution's representative trace (the first
 *  field) — keeps the "which history did this commit use" answer attached to
 *  the ordered result without retaining the whole verdict. */
export interface RewindCommittedEntry<P = unknown> {
  readonly frame: number;
  /** 0-based insertion order WITHIN `frame`. */
  readonly seq: number;
  readonly payload: P;
  readonly duplicate: boolean;
  readonly late: boolean;
  readonly debug: RewindDebug;
}

export type RewindCommitResult<P = unknown> =
  | { ok: true; commit: RewindCommittedEntry<P> }
  | { ok: false; reason: RewindCommitRejectReason; message: string };

/** Receives each frame's committed entries as ONE batch, at the
 *  {@link Rewind.record} boundary, in frame/FIFO order. */
export type RewindCommitCallback = (entries: ReadonlyArray<RewindCommittedEntry>) => void;

/** Options for {@link Rewind.get} / {@link Room.allowRewindState}. */
export interface RewindOptions {
  /** Default rewind window (ms) for attaches that don't pass their own — sizes the
   *  per-entity history ring. Per-attach `maxRewindMs` overrides it. Default 500. */
  maxRewindMs?: number;
  /** Default frame-depth wall for attaches that don't pass their own
   *  ({@link AttachOptions.maxRewindFrames}). Default ∞ (time window only). */
  maxRewindFrames?: number;
  /** Optional ordered-result sink: invoked at every server-frame boundary with
   *  that frame's {@link RewindVerdict.submit}ted entries, oldest frame first
   *  and insertion-ordered within it. {@link Rewind.takeCommitted} is the
   *  pull-based twin. */
  onCommit?: RewindCommitCallback;
}

/** Field's `$values` index from the schema metadata (`metadata[name]` = index), or
 *  -1 if unknown. Resolved ONCE per constructor (cold path), never per tick. */
function fieldIndexOf(instance: object, field: string): number {
  const md = (instance.constructor as any)[$METADATA] as Record<string, unknown> | undefined;
  const idx = md?.[field];
  return typeof idx === "number" ? idx : -1;
}

/** The lag-comp technique an attach-group rewinds to — the TIMELINE the client
 *  displays those targets on. `"snapshot"` (default): the renderTime stamp (what
 *  a lerping/damped client shows, behind real time). `"reckon"`: the reckonTime
 *  stamp (what a forward-extrapolated client shows, ≈ serverNow). Declared at
 *  {@link Rewind.attachAll}, not on the schema. */
export type RewindMode = "snapshot" | "reckon";

/** A per-entity-type window value: one constant, or a fn the group evaluates
 *  once PER ENTITY (its return can differ per constructor — e.g. players 500ms,
 *  NPCs 100ms). */
type PerEntity<V> = V | ((entity: any) => V);

/** Resolve a window value for one entity and validate it. */
function resolveWindow(value: PerEntity<number>, entity: object, isFrames: boolean): number {
  const v = typeof value === "function" ? value(entity) : value;
  if (!Number.isFinite(v) && !(isFrames && v === Infinity)) {
    throw new Error(`Rewind: ${isFrames ? "maxRewindFrames" : "maxRewindMs"} must be a finite positive number (got ${v}).`);
  }
  if (v <= 0) {
    throw new Error(`Rewind: ${isFrames ? "maxRewindFrames" : "maxRewindMs"} must be > 0 (got ${v}).`);
  }
  return v;
}

/** Probe outcome for one field at one past time. */
interface StrictProbe {
  ok: boolean;
  reason?: RewindRejectReason;
  value?: number;
  method?: "exact" | RewindInterp;
  usedFrames?: RewindFrameInfo[];
  depthFrames?: number;
  oldestTime?: number;
  newestTime?: number;
}

/**
 * Per-entity ring of recent field snapshots. `valueAt(time, col)` reconstructs
 * one field's recorded PATH at an arbitrary past time — `linear` interp for
 * continuous motion (patrol, a sine bob), or `step` (hold the last value) for
 * discrete motion (teleport snaps), where a lerp would smear across the jump.
 */
class EntityHistory {
  readonly fields: readonly string[];
  /** The attach-group's `mode: "reckon"` technique, mirrored here so a view can
   *  pick its aim time PER FIELD (each field's covering history carries it). */
  readonly reckoned: boolean;
  /** The attach-group this history belongs to. One entity can have several
   *  histories (attached to multiple groups over disjoint fields); `record()`
   *  finds the right one by this id. */
  readonly groupId: number;
  /** Each tracked field's index into the entity's dense `$values` array —
   *  resolved per CONSTRUCTOR (mixed-type collections differ per type). */
  private readonly fieldIdx: readonly number[];
  private readonly cap: number;
  private readonly t: Float64Array;
  /** Monotonic server-frame index per sample slot, parallel to {@link t}. */
  private readonly fr: Int32Array;
  private readonly cols: Float64Array[];   // one column per field
  private readonly step: boolean;           // hold (vs lerp) between samples
  /** Record cadence hint for frame-depth extrapolation past the ring's oldest
   *  sample (the Rewind's sample interval at history creation). */
  private readonly cadenceMs: number;
  /** Retention walls, resolved per entity (a per-entity fn can vary by type). */
  readonly maxRewindMs: number;
  readonly maxRewindFrames: number;
  private head = 0;                         // next write slot
  private count = 0;
  /** When the ring just wrapped and is refilling, slot 0 is the NEWEST
   *  sample (not the oldest) until the refill catches the tail: slot 0
   *  alone holds history newer than slots 1.., so a target below its time is
   *  simply not yet covered rather than an eviction gap. Cleared once
   *  `head` returns to 0. */
  private refilling = false;

  constructor(fields: readonly string[], fieldIdx: readonly number[], maxRewindMs: number, maxRewindFrames: number, sampleIntervalMs: number, step: boolean, reckoned: boolean, groupId: number) {
    this.fields = fields;
    this.fieldIdx = fieldIdx;
    this.step = step;
    this.reckoned = reckoned;
    this.groupId = groupId;
    this.maxRewindMs = maxRewindMs;
    this.maxRewindFrames = maxRewindFrames;
    this.cadenceMs = sampleIntervalMs;
    // Size for the time window AND the frame-depth wall, plus slack so the
    // interp bracket / depth boundary can't be evicted by one tick of jitter.
    const byTime = Math.ceil(maxRewindMs / sampleIntervalMs) + RING_SLACK;
    const byFrames = Number.isFinite(maxRewindFrames) ? Math.floor(maxRewindFrames) + RING_SLACK : 0;
    this.cap = Math.max(2, byTime, byFrames);
    this.t = new Float64Array(this.cap);
    this.fr = new Int32Array(this.cap);
    this.cols = fields.map(() => new Float64Array(this.cap));
  }

  /** `values` = the entity's dense `$values` array. Direct array reads — no
   *  per-field megamorphic accessor. */
  record(time: number, frame: number, values: ArrayLike<number>): void {
    const fieldIdx = this.fieldIdx;
    const slot = this.head;
    this.t[slot] = time;
    this.fr[slot] = frame;
    for (let f = 0; f < fieldIdx.length; f++) this.cols[f][slot] = values[fieldIdx[f]];
    if (this.count >= this.cap) this.refilling = true;
    this.head = (slot + 1) % this.cap;
    if (this.count < this.cap) this.count++;
    if (this.head === 0) this.refilling = false;
  }

  /** Rewrite the NEWEST slot in place (a second `record()` at the SAME time on
   *  the same frame — the framework's idempotent auto-record). No head/count
   *  change: the frame is one sample, recorded twice is still one sample. */
  overwriteNewest(time: number, frame: number, values: ArrayLike<number>): void {
    if (this.count === 0) { this.record(time, frame, values); return; }
    const slot = (this.head - 1 + this.cap) % this.cap;
    const fieldIdx = this.fieldIdx;
    this.t[slot] = time;
    this.fr[slot] = frame;
    for (let f = 0; f < fieldIdx.length; f++) this.cols[f][slot] = values[fieldIdx[f]];
  }

  get retainedCount(): number { return this.count; }

  private oldestSlot(): number { return (this.head - this.count + this.cap) % this.cap; }
  private newestSlot(): number { return (this.head - 1 + this.cap) % this.cap; }

  /** Oldest/newest RETAINED sample time (-1 before the first record). */
  get oldestTime(): number { return this.count === 0 ? -1 : this.t[this.oldestSlot()]; }
  get newestTime(): number { return this.count === 0 ? -1 : this.t[this.newestSlot()]; }

  /** Interpolated value of column `col` at `time`, clamped to the retained
   *  range. LOOSE path (valueAt/RewindView) — the strict {@link probeAt} never
   *  clamps. */
  valueAt(time: number, col: number): number {
    const c = this.cols[col];
    const oldest = this.oldestSlot();
    if (time <= this.t[oldest]) return c[oldest];
    const newest = this.newestSlot();
    if (time >= this.t[newest]) return c[newest];
    let prev = oldest;
    for (let i = 1; i < this.count; i++) {
      const idx = (oldest + i) % this.cap;
      if (this.t[idx] >= time) {
        if (this.step) return c[prev];   // discrete: hold the value before `time`
        const t0 = this.t[prev], t1 = this.t[idx];
        const a = t1 > t0 ? (time - t0) / (t1 - t0) : 0;
        return c[prev] + (c[idx] - c[prev]) * a;
      }
      prev = idx;
    }
    return c[newest];   // unreachable: `newest` guard above covers it
  }

  /** Integer frame distance from the newest recorded sample to a target
   *  time: the count of recorded frames strictly newer than `time`.
   *  Monotonic frame indices make this an exact count inside the retained
   *  span; below the oldest retained sample it extrapolates from the
   *  RECORDED cadence (gap the frame nearest `time` via time distance — no
   *  retained-slot fudge). */
  private frameDepthAt(time: number, newest: number): number {
    const oldest = this.oldestSlot();
    if (time < this.t[oldest]) {
      // Frames strictly newer than the target: retained ones from the
      // oldest retained sample up, plus the evicted span between the
      // target time and that oldest sample (measured in recorded cadence).
      const retainedFromOldest = this.fr[newest] - this.fr[oldest] + 1;
      const evictedToOldest = Math.max(0, Math.round((this.t[oldest] - time) / this.cadenceMs));
      return retainedFromOldest + evictedToOldest - 1;
    }
    for (let i = 1; i < this.count; i++) {
      const idx = (oldest + i) % this.cap;
      if (this.t[idx] >= time) return this.count - i;
    }
    return 0;
  }

  /**
   * STRICT read of column `col` at `time`: the value plus the exact sample(s)
   * it came from and the frame depth — or a typed refusal. Unlike
   * {@link valueAt} it NEVER clamps: out-of-window stamps, depth-wall breaches
   * and evicted-frame gaps all come back as reasons.
   *
   * Wall order: future skew → time wall → depth wall → retention gap. The time
   * wall is the primary anti-spoof bound (always checked, even when the ring
   * happens to retain more); a target older than the oldest retained sample
   * that is INSIDE the time wall is a depth breach when that oldest sample
   * itself already exceeds the frame wall, otherwise a history gap.
   */
  probeAt(time: number, col: number): StrictProbe {
    if (this.count === 0) {
      return { ok: false, reason: "history-gap", oldestTime: -1, newestTime: -1 };
    }
    const oldest = this.oldestSlot();
    const newest = this.newestSlot();
    const oldestTime = this.t[oldest];
    const newestTime = this.t[newest];
    if (time > newestTime) {
      return { ok: false, reason: "ahead-of-server", oldestTime, newestTime };
    }
    // EVICTED-FRAME check, BEFORE the retained-range walk. Once the ring has
    // wrapped it stores time-ORDER, not slot-order: on a full ring slot 0 is
    // the oldest retained sample, but while it is REFILLING after a wrap,
    // slot 0 is the newest and slots below it are simply unwritten (not an
    // eviction gap). Times strictly below a full ring's slot-0 timestamp were
    // overwritten — refuse, picking the wall reason the same way the
    // retained-range branch does.
    if (this.count >= this.cap && !this.refilling && time < this.t[0]) {
      let reason: RewindRejectReason;
      if (newestTime - time > this.maxRewindMs) {
        reason = "rewind-too-far-time";
      } else {
        // Depth against the NEWEST frame (helper adds the evicted count);
        // the oldest-retained delta alone misclassifies an eviction gap as a
        // depth breach once the ring has wrapped past the wall.
        reason = this.frameDepthAt(time, newest) > this.maxRewindFrames ? "rewind-too-far-frames" : "history-gap";
      }
      return { ok: false, reason, oldestTime, newestTime };
    }
    if (time < oldestTime) {
      let reason: RewindRejectReason;
      if (newestTime - time > this.maxRewindMs) {
        reason = "rewind-too-far-time";
      } else {
        reason = this.frameDepthAt(time, newest) > this.maxRewindFrames ? "rewind-too-far-frames" : "history-gap";
      }
      return { ok: false, reason, oldestTime, newestTime };
    }
    const c = this.cols[col];
    if (time === oldestTime) {
      return {
        ok: true, value: c[oldest], method: "exact",
        usedFrames: [{ frame: this.fr[oldest], time: oldestTime }],
        depthFrames: this.count - 1,
      };
    }
    let prev = oldest;
    for (let i = 1; i < this.count; i++) {
      const idx = (oldest + i) % this.cap;
      if (this.t[idx] >= time) {
        // Samples strictly newer than the target: count-1 - (i-1) = count-i.
        const depthFrames = this.count - i;
        if (depthFrames > this.maxRewindFrames) {
          return { ok: false, reason: "rewind-too-far-frames", oldestTime, newestTime };
        }
        if (this.t[idx] === time) {
          return {
            ok: true, value: c[idx], method: "exact",
            usedFrames: [{ frame: this.fr[idx], time: this.t[idx] }],
            depthFrames,
          };
        }
        if (this.step) {
          return {
            ok: true, value: c[prev], method: "step",
            usedFrames: [
              { frame: this.fr[prev], time: this.t[prev] },
              { frame: this.fr[idx], time: this.t[idx] },
            ],
            depthFrames,
          };
        }
        const t0 = this.t[prev], t1 = this.t[idx];
        const a = t1 > t0 ? (time - t0) / (t1 - t0) : 0;
        return {
          ok: true, value: c[prev] + (c[idx] - c[prev]) * a, method: "linear",
          usedFrames: [
            { frame: this.fr[prev], time: t0 },
            { frame: this.fr[idx], time: t1 },
          ],
          depthFrames,
        };
      }
      prev = idx;
    }
    // time === newestTime (the `time < oldest` early-out didn't catch equality
    // at the other end; walk only reaches here for the newest boundary).
    return {
      ok: true, value: c[newest], method: "exact",
      usedFrames: [{ frame: this.fr[newest], time: newestTime }],
      depthFrames: 0,
    };
  }
}

/** The histories an entity accumulates — one per attach-group it belongs to
 *  (length 1 in the common single-group case). Stored under {@link $HISTORY} on
 *  the entity; GC'd with it. */
type EntityHistories = EntityHistory[];

/** Find the history covering `field` (the group that recorded it), or undefined
 *  → read live. Disjoint field sets across groups make the first match the only
 *  match; the scan is length-1 in every common case. */
function historyForField(instance: object, field: string): EntityHistory | undefined {
  const arr = (instance as any)[$HISTORY] as EntityHistories | undefined;
  if (arr === undefined) return undefined;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].fields.indexOf(field) >= 0) return arr[i];
  }
  return undefined;
}

type Interp = RewindInterp;

/**
 * A read-only view of the tracked world at ONE past time — the rewound state a
 * hit test reads instead of live positions. Created by {@link Rewind.at} /
 * {@link Rewind.lastSeenBy}, which bake in the `maxRewindMs` clamp and the
 * live-fallback so callers never re-implement either.
 *
 * The view assumes NOTHING about your schema's field names — you name the
 * fields (and therefore the shape) at the call site:
 *
 * ```ts
 * const seen = rewind.lastSeenBy(shooterSessionId);
 * // read fields directly…
 * overlaps(bullet, seen.value(target, "x"), seen.value(target, "y"));
 * // …or batch them into an object shaped by YOUR field list:
 * const pos = seen.read(target, ["x", "y"]);        // { x, y }
 * seen.read(enemy, ["x", "y"], this.seenScratch);   // fill + return a reused scratch
 * ```
 *
 * By default `at`/`lastSeenBy` re-aim and return the Rewind's own internal
 * view — the usual "one view at a time, read it right away" flow is zero-alloc
 * AND zero-setup (the server is single-threaded; nothing interleaves a
 * synchronous read). Need more than one view alive at once (compare two
 * shooters' perspectives, A/B a rewind window)? Pass your own instance as
 * their `out` — it is re-aimed and returned instead of the shared one:
 *
 * ```ts
 * const a = rewind.lastSeenBy(shooterA);                      // shared default view
 * const b = rewind.lastSeenBy(shooterB, new RewindView());    // independent second view
 * ```
 *
 * Don't store a view across calls or ticks: the default is re-aimed by the
 * next `at`/`lastSeenBy`, and ANY view's clamp was computed against
 * `lastRecordedAt`, so it goes stale at the next `record()` regardless.
 */
export class RewindView {
  /** Bound (and re-bound) by {@link _retarget} — a bare `new RewindView()` is
   *  un-aimed scratch until it first passes through at()/lastSeenBy(). */
  private rewind?: Rewind;
  private _time = 0;
  private _reckonTime = 0;

  /** The clamped server-time (ms) this view reads at — after the maxRewindMs
   *  clamp and the live (newest-sample) fallback. Mostly for logging/debug. */
  get time(): number { return this._time; }

  /** The clamped server-time (ms) `mode: "reckon"` groups read at — the
   *  client's reconstructed simulation instant, not the raw stamp (see
   *  {@link Rewind.at}). Always a resolved instant: a clamped direct stamp,
   *  or the midpoint/live reconstruction when unstamped. `0` only before the
   *  first `record()`. */
  get reckonTime(): number { return this._reckonTime; }

  /** @internal Aim at a rewind + clamped times ({@link Rewind.at} owns the clamps). */
  _retarget(rewind: Rewind, at: number, reckonAt: number): this {
    this.rewind = rewind;
    this._time = at;
    this._reckonTime = reckonAt;
    return this;
  }

  /** Rewound value of a numeric `field` on `entity` (live if it isn't tracked). */
  value<T extends object>(entity: T, field: NumericKeys<T>): number {
    if (this.rewind === undefined) {
      throw new Error("RewindView is not aimed — obtain it from rewind.at()/lastSeenBy(), or pass it to them as `out`.");
    }
    // The field's covering attach-group picks the timeline: mode:"reckon" reads
    // at the reckon-display instant, mode:"snapshot" at the renderTime stamp.
    const h = historyForField(entity, field);
    if (h === undefined) return (entity as Record<string, number>)[field];   // untracked → live
    return h.valueAt(h.reckoned ? this._reckonTime : this._time, h.fields.indexOf(field));
  }

  /**
   * Batch {@link value} reads: the `fields` YOU list define the result's shape
   * (`Record<field, number>`). Pass `out` to fill (and return) a reused scratch
   * instead of allocating — its properties beyond `fields` are left untouched,
   * so a scratch can carry extra context (an `alive` flag, say).
   */
  read<T extends object, F extends NumericKeys<T>, O extends Record<F, number> = Record<F, number>>(
    entity: T,
    fields: readonly F[],
    out?: O,
  ): O {
    const o = (out ?? {}) as Record<F, number>;
    for (let i = 0; i < fields.length; i++) o[fields[i]] = this.value(entity, fields[i]);
    return o as O;
  }
}

/** Array-form `fields` resolved against one constructor: names with a known
 *  `$values` index, in lock-step. Fields a type doesn't declare are dropped
 *  (they read live) instead of recording `values[-1]` garbage. */
interface ResolvedFields { fields: readonly string[]; idx: readonly number[]; }

interface TrackedGroup {
  entities: () => Iterable<object>;
  fields: readonly string[] | ((entity: any) => readonly string[]);
  /** Per-constructor resolution of array-form `fields` — one entry per entity
   *  type seen in the group (mixed-type collections differ per type). */
  resolvedByCtor: Map<Function, ResolvedFields>;
  maxRewindMs: PerEntity<number>;
  /** Frame-depth wall per entity type (Infinity = time window alone). */
  maxRewindFrames: PerEntity<number>;
  interpolate: Interp | ((entity: any) => Interp);
  /** `true` when this group's `mode` is `"reckon"` (vs the `"snapshot"` default). */
  reckoned: boolean;
  /** Stable id (push index) — links an entity's per-group {@link EntityHistory}
   *  back to its group so the same collection can be attached more than once. */
  groupId: number;
}

/**
 * Per-attach options for {@link Rewind.attachAll} / {@link Rewind.attach}.
 */
interface AttachOptions<E> {
  /** Numeric fields to record per tick. An array applies to every type in the
   *  collection (fields a type lacks are skipped — they read live); a per-entity
   *  fn picks the list per entity, mirroring `interpolate`'s fn form. */
  fields: readonly NumericKeys<E>[] | ((entity: E) => readonly NumericKeys<E>[]);
  /** History retention DURATION per entity type — the rewind window in ms. A
   *  number applies group-wide; a fn is evaluated once per entity (return
   *  different windows per constructor: players 500ms, NPCs 100ms). Defaults to
   *  the {@link RewindOptions.maxRewindMs} room default. Sizes the ring. */
  maxRewindMs?: PerEntity<number>;
  /** Maximum rewind DEPTH in whole recorded frames per entity type — a second,
   *  independent wall alongside `maxRewindMs` (a read breaching EITHER is
   *  refused). Same constant-or-per-entity-fn shape; default ∞ (the time window
   *  alone bounds). Ensures the ring retains at least this many samples. */
  maxRewindFrames?: PerEntity<number>;
  /** How `valueAt` reconstructs between samples (a mode or a per-entity fn,
   *  default `linear`) — use `step` for discrete motion (e.g. teleporters). */
  interpolate?: Interp | ((entity: E) => Interp);
  /**
   * The lag-comp TIMELINE these fields rewind to — must match how the CLIENT
   * displays this target ("what you see is what you hit"):
   *   - `"snapshot"` (default): rewind to the client's `renderTime` — for
   *     targets it shows INTERPOLATED (Predict `lerp`/`damped`), behind real
   *     time by its interp buffer + rtt/2.
   *   - `"reckon"`: rewind to the client's `reckonTime` (≈ its serverNow) — for
   *     targets it forward-extrapolates (Predict `reckon`).
   * Attach the same collection twice with disjoint `fields` to mix techniques.
   * The room ships exactly the stamp(s) its attached groups need (see the
   * handshake derivation in `Room`).
   */
  mode?: RewindMode;
}

/** Options for the strict single-target reads. */
export interface StrictReadOptions<O> {
  /** Multi-field scratch object to fill + return (same convention as
   *  {@link RewindView.read}); the verdict's `value` is this object. */
  out?: O;
}

/** Per-field resolution instruction: a time/timeline/estimated triple, or a
 *  prebuilt rejection (timeline skew / untracked / wall / gap). */
type FieldAim =
  | { time: number; estimated: boolean; timeline: RewindResolveMode }
  | { reject: ResolveEntry };

/**
 * Immutable per-read RESOLUTION cached for the current server frame. Repeated
 * identical reads in the frame reuse this (no re-probe); each call still gets
 * its OWN public {@link VerdictView} (so per-call `duplicate` flags and `out`
 * scratch objects can't alias), and submit-dedupe keys off this entry rather
 * than off a verdict instance.
 */
class ResolveEntry {
  ok: boolean = false;
  // success
  values: Record<string, number> = {};
  serverFrame: number = 0;
  late: boolean = false;
  frameDepth: number = 0;
  traces: Record<string, RewindDebug> = {};
  fieldsList: readonly string[] = [];
  // rejection
  reason: RewindRejectReason | undefined;
  field: string | undefined;
  message: string = "";
  requestedTime: number = 0;
  newestTime: number = -1;
  oldestTime: number = -1;
}

/** Public success verdict — a fresh view per call over a cached {@link ResolveEntry}. */
class VerdictView implements RewindVerdict {
  readonly ok = true as const;
  readonly value: any;
  readonly serverFrame: number;
  readonly late: boolean;
  readonly frameDepth: number;
  readonly duplicate: boolean;
  readonly debug: RewindDebug;
  readonly fields: Readonly<Record<string, RewindDebug>> | undefined;
  /** Cached resolution this view reads — the submit-dedupe key. */
  private readonly entry: ResolveEntry;
  private readonly rewind: Rewind;

  constructor(rewind: Rewind, entry: ResolveEntry, duplicate: boolean, multi: boolean, out: any) {
    this.rewind = rewind;
    this.entry = entry;
    this.duplicate = duplicate;
    this.serverFrame = entry.serverFrame;
    this.late = entry.late;
    this.frameDepth = entry.frameDepth;
    this.debug = entry.traces[entry.fieldsList[0]!]!;
    this.fields = multi ? entry.traces : undefined;
    if (multi) {
      if (out !== undefined) {
        // A caller scratch: always fill IT (first call or duplicate) and
        // return it — Read()-style, so a reused object stays the identity.
        for (const f of entry.fieldsList) out[f] = entry.values[f];
        this.value = out;
      } else if (duplicate) {
        // Duplicate with no scratch: fresh object copied from the cache.
        const target: Record<string, number> = {};
        for (const f of entry.fieldsList) target[f] = entry.values[f];
        this.value = target;
      } else {
        this.value = entry.values;
      }
    } else {
      this.value = entry.values[entry.fieldsList[0]!];
    }
  }

  submit<P>(payload: P): RewindCommitResult<P> {
    return this.rewind.commit(this.entry, payload, this.duplicate, this.late);
  }
}

/** Public rejection view (fresh per call; carries no submit). */
class RejectionView {
  readonly ok = false as const;
  readonly reason: RewindRejectReason;
  readonly field: string | undefined;
  readonly message: string;
  readonly requestedTime: number;
  readonly newestTime: number;
  readonly oldestTime: number;
  readonly serverFrame: number;

  constructor(entry: ResolveEntry) {
    this.reason = entry.reason!;
    this.field = entry.field;
    this.message = entry.message;
    this.requestedTime = entry.requestedTime;
    this.newestTime = entry.newestTime;
    this.oldestTime = entry.oldestTime;
    this.serverFrame = entry.serverFrame;
  }
}

/** Immutable-ish debug trace implementation. */
class DebugTrace implements RewindDebug {
  readonly field: string;
  readonly requestedTime: number;
  readonly resolvedTime: number;
  readonly timeline: RewindResolveMode;
  readonly estimated: boolean;
  readonly usedFrames: readonly RewindFrameInfo[];
  readonly method: "exact" | RewindInterp;
  readonly depthMs: number;
  readonly depthFrames: number;
  readonly maxRewindMs: number;
  readonly maxRewindFrames: number;
  readonly retainedFrames: number;
  readonly late: boolean;

  constructor(
    field: string, requestedTime: number, resolvedTime: number, timeline: RewindResolveMode,
    estimated: boolean, usedFrames: readonly RewindFrameInfo[], method: "exact" | RewindInterp,
    depthMs: number, depthFrames: number, h: EntityHistory,
  ) {
    this.field = field;
    this.requestedTime = requestedTime;
    this.resolvedTime = resolvedTime;
    this.timeline = timeline;
    this.estimated = estimated;
    this.usedFrames = usedFrames;
    this.method = method;
    this.depthMs = depthMs;
    this.depthFrames = depthFrames;
    this.maxRewindMs = h.maxRewindMs;
    this.maxRewindFrames = h.maxRewindFrames;
    this.retainedFrames = h.retainedCount;
    this.late = depthFrames > 1;
  }

  describe(): string {
    const frames = this.usedFrames.map((f) => `#${f.frame}@${round(f.time)}ms`).join("→");
    const depthLimit = Number.isFinite(this.maxRewindFrames) ? this.maxRewindFrames : "∞";
    const hit = this.method === "exact" ? "exact hit" : this.method;
    return (
      `${this.field} @${round(this.resolvedTime)}ms via [${frames}] (${hit}${this.estimated ? ", estimated midpoint" : ""})` +
      ` — depth ${round(this.depthMs)}ms/${this.depthFrames}f` +
      ` (limit ${round(this.maxRewindMs)}ms/${depthLimit}f, ${this.retainedFrames} retained${this.late ? ", LATE" : ""})`
    );
  }
}

function round(n: number): number { return Math.round(n * 1000) / 1000; }

/**
 * Server-side lag compensation — the dual of the client's `Predict`. Where
 * `Predict` forward-reckons entities it RECEIVES, `Rewind` records the recent
 * positions of entities it OWNS and rewinds field reads to a past (client
 * render) time, so a hit test judges against where the client actually SAW an
 * entity — not where it has slid to ~RTT later.
 *
 * Prefer {@link Room.allowRewindState}, which creates a `Rewind` and records it
 * automatically each simulation tick:
 *
 * @example
 * ```ts
 * onCreate() {
 *   const rewind = this.allowRewindState({ maxRewindMs: 500 });
 *   rewind.attachAll(this.state.enemies, { fields: ["x", "y"] });  // fields ← Enemy's numeric keys
 *   this.setTimestep((dt) => { ...move enemies... }, 1000 / 30);
 *   // framework calls rewind.record() after each tick.
 * }
 * // in your hit test, with the client's renderTime:
 * const seenX = rewind.valueAt(enemy, renderTime, "x");
 * ```
 *
 * `attachAll` takes the live collection (not a string key), so the element type
 * — and the legal `fields` / `valueAt` field names — are inferred with no
 * state-type generic. Entities are keyed by object identity — removed entities
 * and their history are reclaimed automatically.
 *
 * The rewind TIMELINE is declared per attach-group via `attachAll(coll, { mode })`:
 * `"snapshot"` (default) reads at the client's `renderTime` stamp, `"reckon"` at
 * its `reckonTime` (see {@link at}). Not-attached = not rewound (reads are live)
 * — there is no "none". The same collection may be attached more than once with
 * disjoint `fields` to put different fields on different timelines. The room
 * ships exactly the stamp(s) these groups need (handshake derivation reads
 * {@link timelineMode}); the client declares its display mode independently.
 *
 * ## Two read surfaces
 *
 * - **Loose** — {@link at} / {@link lastSeenBy} / {@link valueAt}: clamp an
 *   out-of-window stamp to the window edge and read live when untracked. The
 *   ergonomic default; a skewed clock silently judges at the edge.
 * - **Strict** — {@link resolveValueAt} / {@link resolveAt} /
 *   {@link resolveSeenBy}: return a tagged {@link RewindResult} with an
 *   observable {@link RewindRejectReason} for every case the loose path hides
 *   (future skew, time/frame walls, evicted frames, unsynced clock, untracked
 *   field). Each ok verdict carries the exact history frame(s) used and can
 *   {@link RewindVerdict.submit} its result onto an ordered, frame-tagged
 *   commit ledger. Set `DEBUG=colyseus:rewind` to trace both surfaces.
 */
export class Rewind {
  private static readonly byRoom = new WeakMap<object, Rewind>();

  /** One `Rewind` per room (idempotent). `room` is only the cache key. */
  static get(room: object, opts?: RewindOptions): Rewind {
    let r = Rewind.byRoom.get(room);
    if (r === undefined) {
      r = new Rewind(
        opts?.maxRewindMs ?? DEFAULT_MAX_REWIND_MS,
        opts?.maxRewindFrames ?? DEFAULT_MAX_REWIND_FRAMES,
        opts?.onCommit,
      );
      Rewind.byRoom.set(room, r);
    }
    return r;
  }

  private readonly groups: TrackedGroup[] = [];
  private readonly defaultMaxRewindMs: number;
  private readonly defaultMaxRewindFrames: number;
  private readonly onCommit?: RewindCommitCallback;
  private _sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS;
  private _lastRecordedAt = -1;
  /** Monotonic server-frame counter — incremented on each distinct-time
   *  {@link record}; samples and verdicts are tagged with it. */
  private _frame = -1;
  /** Results submitted for the CURRENT frame; flushed FIFO at the next frame
   *  boundary ({@link advanceFrame}). */
  private _pending: RewindCommittedEntry[] = [];
  /** Frames already committed, awaiting pull via {@link takeCommitted}. */
  private _committed: RewindCommittedEntry[] = [];
  /** Per-frame insertion seq for {@link _pending}. */
  private _seq = 0;
  /** Verdict resolution → its ledger entry this frame: a duplicate submit is
   *  idempotent (re-submission returns the same entry, flagged). */
  private readonly _entriesByResolve = new WeakMap<ResolveEntry, RewindCommittedEntry>();
  /** Same-frame resolution memos (cleared at each frame boundary). */
  private _memo = new WeakMap<object, Map<string, ResolveEntry>>();
  /** Resolves a client's auto-stamped render time (set by `Room.allowRewindState`
   *  when a `mode:"snapshot"` group is attached); powers {@link lastSeenBy}. */
  private _renderTimeOf?: (sessionId: string) => number;
  /** Resolves a client's auto-stamped reckon-display instant (its serverNow
   *  estimate at input-sample time). When present (> 0), {@link lastSeenBy}
   *  reads `mode:"reckon"` groups AT this stamp directly — exact regardless
   *  of the client's clock/RTT-estimation error (it displayed f(est), we read
   *  f(est)) — instead of reconstructing it via the midpoint. */
  private _reckonTimeOf?: (sessionId: string) => number;
  /** Resolves the CURRENT server time (set by `Room.allowRewindState`) — the
   *  reckon midpoint's "now" anchor in {@link at}. Without it, the anchor falls
   *  back to `lastRecordedAt`, which is one tick stale at hit-test time. */
  private _nowOf?: () => number;
  /** Default view returned by at/lastSeenBy when no `out` is given — one per
   *  Rewind, re-aimed per call (zero alloc, zero userland setup). */
  private readonly _view = new RewindView();

  private constructor(defaultMaxRewindMs: number, defaultMaxRewindFrames: number, onCommit?: RewindCommitCallback) {
    this.defaultMaxRewindMs = defaultMaxRewindMs;
    this.defaultMaxRewindFrames = defaultMaxRewindFrames;
    this.onCommit = onCommit;
  }

  /** The default rewind window (ms). Use it to bound a hit test:
   *  `Math.max(renderTime, now - rewind.maxRewindMs)`. */
  get maxRewindMs(): number { return this.defaultMaxRewindMs; }
  /** The default frame-depth wall (∞ when only the time window bounds). */
  get maxRewindFrames(): number { return this.defaultMaxRewindFrames; }
  /** Server time of the last {@link record} (or -1). The auto-record skips a tick
   *  whose time was already recorded manually — your `record()` wins. */
  get lastRecordedAt(): number { return this._lastRecordedAt; }
  /** The current server frame index (the {@link record} count, 0-based; -1
   *  before the first record). Verdicts are tagged with this. */
  get currentFrame(): number { return this._frame; }

  /** Track every entity in a collection (Map/Array/Set schema). `fields` narrows
   *  to its element's numeric fields. `maxRewindMs`/`maxRewindFrames` accept a
   *  number or a per-entity fn (different retention per entity TYPE).
   *  `interpolate` (a mode or a per-entity fn, default `linear`) picks how
   *  `valueAt` reconstructs between samples — use `step` for discrete-motion
   *  entities (e.g. teleporters). `mode` picks the lag-comp timeline (default
   *  `"snapshot"`; see {@link AttachOptions}). */
  attachAll<E extends object>(
    collection: Collection<E>,
    opts: AttachOptions<E>,
  ): this {
    const c = collection as unknown as { values(): Iterable<object> };
    this.groups.push(this.makeGroup(() => c.values(), opts));
    return this;
  }

  /** Track a single entity (e.g. a boss). `fields` narrows to its numeric
   *  fields. Same window/interp/mode options as {@link attachAll}. */
  attach<E extends object>(instance: E, opts: AttachOptions<E>): this {
    const one: object[] = [instance];   // reused; no per-tick alloc
    this.groups.push(this.makeGroup(() => one, opts));
    return this;
  }

  private makeGroup<E extends object>(entities: () => Iterable<object>, opts: AttachOptions<E>): TrackedGroup {
    return {
      entities,
      fields: opts.fields,
      resolvedByCtor: new Map(),
      maxRewindMs: opts.maxRewindMs ?? this.defaultMaxRewindMs,
      maxRewindFrames: opts.maxRewindFrames ?? this.defaultMaxRewindFrames,
      interpolate: opts.interpolate ?? "linear",
      reckoned: opts.mode === "reckon",
      groupId: this.groups.length,
    };
  }

  /**
   * Snapshot every tracked entity at `now` — the server-frame boundary. Call
   * once per tick, AFTER they move — {@link Room.allowRewindState} does this for
   *  you. `sampleIntervalMs` (the gap between records) sizes the history rings;
   *  the framework passes the sim interval.
   *
   * A distinct `now` ADVANCES the frame: the previous frame's submitted
   * results are committed in FIFO order (the `onCommit` callback /
   * {@link takeCommitted}), per-frame memos are cleared, then samples are
   * tagged with the new frame. Calling again at the SAME `now` overwrites the
   * newest sample in place (idempotent — a manual record this tick wins, and a
   * patchRate faster than the sim dedups back to per-tick).
   */
  record(now: number, sampleIntervalMs?: number): void {
    if (sampleIntervalMs !== undefined && sampleIntervalMs > 0) this._sampleIntervalMs = sampleIntervalMs;
    if (now === this._lastRecordedAt && this._frame >= 0) {
      // Same frame, later call: overwrite the newest snapshot, keep the frame.
      this.recordEntities(now, this._frame, true);
      return;
    }
    if (this._frame >= 0) this.advanceFrame();
    this._frame++;
    this._lastRecordedAt = now;
    this.recordEntities(now, this._frame, false);
  }

  /** Frame boundary: deliver frame N's committed results (frame order, then
   *  FIFO within the frame), reset the per-frame dedupe state. */
  private advanceFrame(): void {
    const entries = this._pending;
    if (entries.length > 0) {
      this._pending = [];
      this._seq = 0;
      if (debugRewind.enabled) {
        debugRewind(`frame #${this._frame} commit: ${entries.length} result(s) in order — seq ${entries[0]!.seq}..${entries[entries.length - 1]!.seq}`);
      }
      this._committed.push(...entries);
      this.onCommit?.(entries);
    }
    this._memo = new WeakMap();
    this._entriesByResolve = new WeakMap();
  }

  private recordEntities(now: number, frame: number, overwrite: boolean): void {
    for (const g of this.groups) {
      for (const e of g.entities()) {
        const t = e as any;   // private-symbol access on a foreign schema instance
        let arr = t[$HISTORY] as EntityHistories | undefined;
        if (arr === undefined) { arr = []; t[$HISTORY] = arr; }
        let h: EntityHistory | undefined;
        for (let i = 0; i < arr.length; i++) { if (arr[i].groupId === g.groupId) { h = arr[i]; break; } }
        if (h === undefined) { h = this.createHistory(g, e); arr.push(h); }   // cold: once per (entity, group)
        const values = t[$values] as ArrayLike<number>;
        if (overwrite) { h.overwriteNewest(now, frame, values); } else { h.record(now, frame, values); }
      }
    }
  }

  /** Cold path — first time an entity is seen by `record()` for a given group.
   *  Resolves the field→`$values` indices (cached per constructor for array-form
   *  `fields`; fn-form resolves per entity), the per-entity-type retention walls,
   *  and bakes in the group's `mode`. */
  private createHistory(g: TrackedGroup, e: object): EntityHistory {
    let rf: ResolvedFields;
    if (typeof g.fields === "function") {
      rf = this.resolveFields(e, g.fields(e));
    } else {
      let cached = g.resolvedByCtor.get(e.constructor);
      if (cached === undefined) {
        cached = this.resolveFields(e, g.fields);
        g.resolvedByCtor.set(e.constructor, cached);
      }
      rf = cached;
    }
    const maxRewindMs = resolveWindow(g.maxRewindMs, e, false);
    const maxRewindFrames = resolveWindow(g.maxRewindFrames, e, true);
    const interp = typeof g.interpolate === "function" ? g.interpolate(e) : g.interpolate;
    return new EntityHistory(rf.fields, rf.idx, maxRewindMs, maxRewindFrames, this._sampleIntervalMs, interp === "step", g.reckoned, g.groupId);
  }

  /** Keep only the fields this entity's type declares (unknown → read live). */
  private resolveFields(e: object, names: readonly string[]): ResolvedFields {
    const fields: string[] = [];
    const idx: number[] = [];
    for (const name of names) {
      const i = fieldIndexOf(e, name);
      if (i >= 0) { fields.push(name); idx.push(i); }
    }
    return { fields, idx };
  }

  /**
   * `instance`'s `field` value at past `time` (interpolated from history). Falls
   * back to the live value when the entity has no history yet, or the field
   * isn't tracked. LOOSE path — clamps to the retained range; see
   * {@link resolveValueAt} for the strict surface.
   */
  valueAt<T extends object>(instance: T, time: number, field: NumericKeys<T>): number {
    const h = historyForField(instance, field);
    if (h === undefined) return (instance as Record<string, number>)[field];
    return h.valueAt(time, h.fields.indexOf(field));
  }

  /**
   * Which timeline(s) the attached groups rewind to — `reckon` true iff any
   * group is `mode:"reckon"`, `snapshot` true iff any is `mode:"snapshot"`. The
   * room reads this once (groups are declared in `onCreate`, before any join) to
   * pick which stamp(s) the client must ship: reckon-only / render-only / both /
   * none. @internal
   */
  timelineMode(): { reckon: boolean; snapshot: boolean } {
    let reckon = false, snapshot = false;
    for (const g of this.groups) {
      if (g.reckoned) reckon = true; else snapshot = true;
    }
    return { reckon, snapshot };
  }

  /**
   * @internal Wire a resolver from sessionId → that client's auto-stamped
   * `renderTime`. Called by {@link Room.allowRewindState} so {@link lastSeenBy}
   * works for `mode:"snapshot"` groups; auto-enabled by attaching one.
   */
  bindRenderTime(resolver: (sessionId: string) => number): void {
    this._renderTimeOf = resolver;
  }

  /**
   * @internal Wire a resolver for the CURRENT server time (ms, same epoch as
   * `record` times). Called by {@link Room.allowRewindState}; standalone users
   * (tests/harnesses) should bind their own. Anchors the reckon midpoint in
   * {@link at} at the true processing instant — the `lastRecordedAt` fallback
   * is one tick stale by hit-test time, biasing the aim ~half a tick early:
   * imperceptible on slow horizontal motion, but enough to flip knife-edge
   * stomp/hit verdicts on fast vertical movers (a bobbing jumper).
   */
  bindNow(resolver: () => number): void {
    this._nowOf = resolver;
  }

  /**
   * @internal Wire a resolver from sessionId → that client's auto-stamped
   * reckon-display instant (`input(sid).reckonTime`). Called by
   * {@link Room.allowRewindState}. With it, {@link lastSeenBy} aims
   * `mode:"reckon"` groups at the EXACT instant the client displayed them
   * (immune to its RTT-estimation error); without it (or while the stamp is
   * still 0), the midpoint reconstruction in {@link at} is the fallback.
   */
  bindReckonTime(resolver: (sessionId: string) => number): void {
    this._reckonTimeOf = resolver;
  }

  /**
   * A {@link RewindView} of the tracked world at `time` (an acting client's render
   * time), with the two things every hit test re-implements baked in:
   *  - **clamp** to `[lastRecordedAt − maxRewindMs, lastRecordedAt]` — an
   *    anti-spoof / clock-skew bound (a client can't rewind arbitrarily far), and
   *  - **live fallback**: `time <= 0` (the client's clock hasn't synced) → the
   *    newest recorded sample (≈ current position).
   *
   * Sugar over {@link valueAt}; pass the render time yourself (e.g. from
   * `input(sid).renderTime`, or a value stored on the entity). For the common
   * "rewind to a specific client's view" case use {@link lastSeenBy}.
   *
   * Re-aims and returns this Rewind's internal view by default — zero alloc,
   * nothing to declare. Pass `out` to aim a view of your own instead; needed
   * only to hold several views at once — see the {@link RewindView} doc.
   */
  at(time: number, out?: RewindView): RewindView {
    return this._aim(time, 0, out);
  }

  /**
   * Shared aiming: clamp the snapshot-timeline `time`, and resolve the reckon
   * timeline either from the DIRECT `reckonStamp` (the instant the client's
   * forward-reckoned entities were displayed at — exact, immune to the
   * client's RTT-estimation error) or, when absent (0), by reconstruction.
   */
  private _aim(time: number, reckonStamp: number, out?: RewindView): RewindView {
    const newest = this._lastRecordedAt;
    const oldest = newest - this.defaultMaxRewindMs;
    // time<=0 → not synced yet → read live (newest). Else clamp into the window.
    const at = time <= 0 ? newest : (time < oldest ? oldest : time > newest ? newest : time);
    // mode:"reckon" groups display forward-extrapolated to ≈ the client's
    // serverNow — rewinding them to the raw snapshot stamp would double-
    // compensate (client extrapolates forward + server rewinds back = a
    // full-RTT ghost in the entity's past).
    let reckonAt: number;
    if (reckonStamp > 0) {
      // Direct stamp: read at exactly what the client displayed. The clamp is
      // the anti-spoof bound, same as the snapshot timeline's.
      reckonAt = reckonStamp < oldest ? oldest : reckonStamp > newest ? newest : reckonStamp;
    } else if (time <= 0) {
      reckonAt = newest;
    } else {
      // Reconstruction fallback (custom `at(time)` users / old clients): with
      // symmetric latency the client's instant is the midpoint of the stamp
      // and ARRIVAL — anchored at the bound "now" (the true processing
      // instant; the lastRecordedAt fallback is one tick stale by hit-test
      // time and biases the aim ~half a tick early — see bindNow). NOTE: the
      // stamp itself embeds the client's rtt/2 estimate, so this path inherits
      // its error — the direct stamp above is the accurate one.
      const anchor = this._nowOf !== undefined ? this._nowOf() : newest;
      const mid = (time + anchor) / 2;
      reckonAt = mid < oldest ? oldest : mid > newest ? newest : mid;
    }
    return (out ?? this._view)._retarget(this, at, reckonAt);
  }

  /**
   * A {@link RewindView} of the world as session `sessionId` LAST saw it —
   * resolves the render time stamped on that client's most recently CONSUMED
   * input (hence "last": under a multi-frame `drain()` it is the newest frame's
   * stamp) and hands off to {@link at}. This is the "what you see is what you
   * hit" path:
   *
   * ```ts
   * const seen = this.rewind.lastSeenBy(shooterSessionId);
   * const hit = overlaps(bullet, seen.value(target, "x"), seen.value(target, "y"));
   * ```
   *
   * Requires the room's framework input (`this.defineInput(Input)`) — the
   * per-client stamp auto-enables from the `attachAll` `mode` of the groups you
   * rewind (declaration order vs `allowRewindState` doesn't matter). A client
   * that merely hasn't stamped yet (clock still syncing, unknown sessionId) is
   * NOT an error — it reads 0 and the view falls back to live. Use
   * {@link at} with an explicit time if you stamp render times yourself.
   *
   * Re-aims and returns this Rewind's internal view by default — zero alloc,
   * nothing to declare. Pass `out` to aim a view of your own instead; needed
   * only to hold several views at once — see the {@link RewindView} doc.
   */
  lastSeenBy(sessionId: string, out?: RewindView): RewindView {
    if (this._renderTimeOf === undefined) {
      throw new Error(
        "Rewind.lastSeenBy(sessionId) needs the framework input API. Declare " +
        "`this.defineInput(Input)` (stamps auto-enable from your attachAll `mode`), " +
        "or call `at(time)` and pass the render time yourself.",
      );
    }
    return this._aim(
      this._renderTimeOf(sessionId),
      this._reckonTimeOf !== undefined ? this._reckonTimeOf(sessionId) : 0,
      out,
    );
  }

  // ---------------------------------------------------------------------------
  // STRICT single-target reads — observable refusals instead of clamps/live.
  // ---------------------------------------------------------------------------

  /** Build a rejection entry shared by the timeline-skew and per-field paths.
   *  `h` (when the field's history is known) supplies its retained range. */
  private rejectionEntry(reason: RewindRejectReason, field: string | undefined, label: string, requested: number, h?: EntityHistory): ResolveEntry {
    const e = new ResolveEntry();
    e.ok = false;
    e.reason = reason;
    e.field = field;
    e.requestedTime = requested;
    e.serverFrame = this._frame;
    e.newestTime = this._lastRecordedAt;
    e.oldestTime = h !== undefined ? h.oldestTime : -1;
    e.message = rejectionMessage(reason, field, requested, e.newestTime, e.oldestTime);
    if (debugRewind.enabled) debugRewind(`${label} → REJECT ${reason}${field ? ` (field '${field}')` : ""}: ${e.message}`);
    return e;
  }

  /** Validate an EXPLICIT past time (resolveValueAt/resolveAt): the caller
   *  owns the stamp, so no midpoint reconstruction — just the two
   *  timeline-skew refusals (unsynced / future). */
  private checkExplicitTime(time: number, label: string): RewindRejectReason | undefined {
    if (!(time > 0)) { this.rejectionEntry("not-synced", undefined, label, time); return "not-synced"; }
    if (time > this._lastRecordedAt) { this.rejectionEntry("ahead-of-server", undefined, label, time); return "ahead-of-server"; }
    return undefined;
  }

  /** Resolve a session's display instant for resolveSeenBy. A snapshot group
   *  uses the direct renderTime stamp. A reckon group uses the direct
   *  reckonTime stamp, or — for an old/unstamped client — the render↔arrival
   *  midpoint reconstruction (`estimated: true`, inherits the client's RTT
   *  estimate error). */
  private resolveSeenStamp(sessionId: string, reckoned: boolean, label: string): { time: number; estimated: boolean; skew?: RewindRejectReason } {
    if (reckoned) {
      if (this._reckonTimeOf === undefined || this._renderTimeOf === undefined) {
        throw new Error(
          "Rewind.resolveSeenBy(...) needs the framework input API. Declare " +
          "`this.defineInput(Input)` (stamps auto-enable from your attachAll `mode`), " +
          "or call resolveAt(time, ...) and pass the time yourself.",
        );
      }
      const direct = this._reckonTimeOf(sessionId);
      if (direct > 0) return { time: direct, estimated: false };
      const render = this._renderTimeOf(sessionId);
      if (!(render > 0)) return { time: 0, estimated: false, skew: "not-synced" };
      const anchor = this._nowOf !== undefined ? this._nowOf() : this._lastRecordedAt;
      const mid = (render + anchor) / 2;
      if (mid > this._lastRecordedAt) return { time: mid, estimated: true, skew: "ahead-of-server" };
      return { time: mid, estimated: true };
    }
    if (this._renderTimeOf === undefined) {
      throw new Error(
        "Rewind.resolveSeenBy(sessionId) needs the framework input API. Declare " +
        "`this.defineInput(Input)` (stamps auto-enable from your attachAll `mode`), " +
        "or call resolveAt(time, ...) and pass the render time yourself.",
      );
    }
    const stamp = this._renderTimeOf(sessionId);
    if (!(stamp > 0)) return { time: stamp, estimated: false, skew: "not-synced" };
    if (stamp > this._lastRecordedAt) return { time: stamp, estimated: false, skew: "ahead-of-server" };
    return { time: stamp, estimated: false };
  }

  /** Strict single-field read at an explicit past `time`. The field's
   *  attach-group determines the timeline shown in the trace — an explicit
   *  time is read verbatim on whatever history covers the field. */
  resolveValueAt<T extends object>(
    entity: T,
    time: number,
    field: NumericKeys<T>,
  ): RewindResult<number> {
    const label = `resolveValueAt(@${round(time)})`;
    const skew = this.checkExplicitTime(time, label);
    return this.resolveFieldsStrict(entity, [field as string], label, (f) => {
      const h = historyForField(entity, f);
      if (skew !== undefined) return { reject: this.rejectionEntry(skew, f, label, time, h) };
      return { time, estimated: false, timeline: h?.reckoned ? "reckon" : "snapshot" };
    }, false) as RewindResult<number>;
  }

  /** Strict multi-field read at an explicit past `time`; `value` is shaped by
   *  YOUR `fields` list (or fills/returns `opts.out`). */
  resolveAt<T extends object, F extends NumericKeys<T>, O extends Record<F, number> = Record<F, number>>(
    entity: T,
    time: number,
    fields: readonly F[],
    opts?: StrictReadOptions<O>,
  ): RewindResult<O> {
    const label = `resolveAt(@${round(time)})`;
    const skew = this.checkExplicitTime(time, label);
    return this.resolveFieldsStrict(entity, fields as readonly string[], label, (f) => {
      const h = historyForField(entity, f);
      if (skew !== undefined) return { reject: this.rejectionEntry(skew, f, label, time, h) };
      return { time, estimated: false, timeline: h?.reckoned ? "reckon" : "snapshot" };
    }, true, opts?.out) as RewindResult<O>;
  }

  /**
   * Strict single-/multi-field read of the world as session `sessionId` LAST
   * saw it — the strict twin of {@link lastSeenBy}. Unlike the loose view (one
   * clamped pair of times), each FIELD is read on ITS OWN group's timeline:
   * `mode:"reckon"` fields at the client's reckon stamp, `mode:"snapshot"`
   * fields at its render stamp — so a mixed-timeline entity resolves exactly.
   * Pass one field for the single-value form, a list for a `{ field: value }`
   * result (or fill/return `opts.out`).
   */
  resolveSeenBy<T extends object>(
    sessionId: string,
    entity: T,
    field: NumericKeys<T>,
  ): RewindResult<number>;
  resolveSeenBy<T extends object, F extends NumericKeys<T>, O extends Record<F, number> = Record<F, number>>(
    sessionId: string,
    entity: T,
    fields: readonly F[],
    opts?: StrictReadOptions<O>,
  ): RewindResult<O>;
  resolveSeenBy(
    sessionId: string,
    entity: object,
    fields: string | readonly string[],
    opts?: StrictReadOptions<any>,
  ): RewindResult<any> {
    const list = typeof fields === "string" ? [fields] : fields;
    const multi = typeof fields !== "string";
    const label = `resolveSeenBy(${sessionId})`;
    return this.resolveFieldsStrict(entity, list, label, (f) => {
      const h = historyForField(entity, f);
      const r = this.resolveSeenStamp(sessionId, h?.reckoned ?? false, label);
      if (r.skew !== undefined) return { reject: this.rejectionEntry(r.skew, f, label, r.time, h) };
      return { time: r.time, estimated: r.estimated, timeline: h?.reckoned ? "reckon" : "snapshot" };
    }, multi, opts?.out);
  }

  /**
   * Shared strict resolver: per-field aim (skew refusal / stamp resolution),
   * per-field wall/gap probe, trace assembly, and the same-frame memo
   * (identical (entity, fields, label) reads reuse the first resolution —
   * same-frame duplicate computation is skipped and observable). A fresh
   * public verdict is returned PER CALL (own `duplicate` flag and `out`
   * scratch); the cached {@link ResolveEntry} is immutable.
   */
  private resolveFieldsStrict(
    entity: object,
    fields: readonly string[],
    label: string,
    aim: (field: string) => FieldAim,
    multi: boolean,
    out?: any,
  ): RewindResult<any> {
    const memoKey = `${label}|${fields.join(",")}`;
    let map = this._memo.get(entity);
    let entry = map?.get(memoKey);
    let duplicate = false;
    if (entry !== undefined) {
      duplicate = true;
      if (debugRewind.enabled && entry.ok) {
        debugRewind(`${label} → same-frame duplicate, reusing resolution for [${fields.join(",")}] @${round(entry.traces[fields[0]!]!.resolvedTime)}ms`);
      }
    } else {
      entry = this.computeStrict(entity, fields, label, aim);
      if (map === undefined) { map = new Map(); this._memo.set(entity, map); }
      map.set(memoKey, entry);
    }
    if (!entry.ok) return new RejectionView(entry);
    return new VerdictView(this, entry, duplicate, multi, out);
  }

  private computeStrict(
    entity: object,
    fields: readonly string[],
    label: string,
    aim: (field: string) => FieldAim,
  ): ResolveEntry {
    const e = new ResolveEntry();
    e.ok = true;
    e.serverFrame = this._frame;
    e.fieldsList = fields;
    let depthFrames = 0;
    let anyLate = false;

    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      const h = historyForField(entity, field);
      if (h === undefined) {
        // Strict never reads live: untracked is an observable refusal.
        return this.rejectionEntry("not-tracked", field, label, this._lastRecordedAt);
      }
      const a = aim(field);
      if ("reject" in a) return a.reject;
      const probe = h.probeAt(a.time, h.fields.indexOf(field));
      if (!probe.ok || probe.value === undefined) {
        return this.rejectionEntry(probe.reason ?? "history-gap", field, label, a.time, h);
      }
      e.values[field] = probe.value;
      depthFrames = Math.max(depthFrames, probe.depthFrames ?? 0);
      const trace = new DebugTrace(
        field, a.time, a.time, a.timeline, a.estimated, probe.usedFrames!, probe.method!,
        this._lastRecordedAt - a.time, probe.depthFrames ?? 0, h,
      );
      if (trace.late) anyLate = true;
      e.traces[field] = trace;
    }

    e.frameDepth = depthFrames;
    e.late = anyLate;
    if (debugRewind.enabled) {
      const first = e.traces[fields[0]!]!;
      debugRewind(`${label} → ${fields.length > 1 ? `[${fields.join(",")}]` : first.describe()}`);
      if (fields.length > 1) for (const f of fields) debugRewind(`  ${e.traces[f]!.describe()}`);
    }
    return e;
  }

  // ---------------------------------------------------------------------------
  // Ordered result ledger.
  // ---------------------------------------------------------------------------

  /**
   * @internal Enqueue a resolution's result for the CURRENT server frame.
   * Keyed by the (immutable, frame-scoped) resolution, not by verdict view:
   * any verdict over a same-frame duplicate read resolves to the SAME ledger
   * entry — the first call enqueues (flagged when the read itself was a
   * duplicate), later calls return it instead of double-committing.
   */
  commit<P>(entry: ResolveEntry, payload: P, readDuplicate: boolean, late: boolean): RewindCommitResult<P> {
    if (entry.serverFrame !== this._frame) {
      return {
        ok: false,
        reason: "frame-stale",
        message: `resolution from frame #${entry.serverFrame} cannot submit at frame #${this._frame} — resolve and submit within the same server frame`,
      };
    }
    const prior = this._entriesByResolve.get(entry);
    if (prior !== undefined) {
      // Same resolution resubmitted this frame (a duplicate read re-submitting):
      // idempotent — return the existing entry rather than enqueuing twice.
      return { ok: true, commit: prior as RewindCommittedEntry<P> };
    }
    const committed: RewindCommittedEntry<P> = {
      frame: this._frame,
      seq: this._seq++,
      payload,
      duplicate: readDuplicate,
      late,
      debug: entry.traces[entry.fieldsList[0]!]!,
    };
    this._pending.push(committed as RewindCommittedEntry);
    this._entriesByResolve.set(entry, committed as RewindCommittedEntry);
    return { ok: true, commit: committed };
  }

  /** Pull (and clear) every committed entry not yet pulled — across frame
   *  boundaries, in server-FRAME order then FIFO within each frame. Use this or
   *  the `onCommit` option, not both against the same backlog. */
  takeCommitted(): RewindCommittedEntry[] {
    const out = this._committed;
    this._committed = [];
    return out;
  }
}

function rejectionMessage(reason: RewindRejectReason, field: string | undefined, requested: number, newest: number, oldest: number): string {
  const what = field ? `field '${field}'` : "stamp";
  switch (reason) {
    case "not-tracked":
      return `${what} is not attached to any rewind group — the strict path reads no live/arbitrary state (use at()/valueAt() for the live fallback)`;
    case "not-synced":
      return `client stamp ${round(requested)} is unset/non-positive — the client clock has not synced yet (loose at() would read the newest frame)`;
    case "ahead-of-server":
      return `client stamp ${round(requested)}ms is newer than the newest server frame @${round(newest)}ms — future clock skew, refusing to extrapolate`;
    case "rewind-too-far-time":
      return `${what} @${round(requested)}ms is ${round(newest - requested)}ms behind @${round(newest)}ms, beyond the configured maxRewindMs (oldest retained @${round(oldest)}ms)`;
    case "rewind-too-far-frames":
      return `${what} @${round(requested)}ms is deeper than the configured maxRewindFrames behind frame @${round(newest)}ms (oldest retained @${round(oldest)}ms)`;
    case "history-gap":
      return `no retained history covers ${what} @${round(requested)}ms — those frames were already evicted (newest @${round(newest)}ms, oldest retained @${round(oldest)}ms); refusing to read arbitrary old state`;
  }
}
