import { $values, type MapSchema, type ArraySchema, type SetSchema } from "@colyseus/schema";
import { $METADATA } from "./utils/Utils.ts";

const DEFAULT_MAX_REWIND_MS = 500;
/** Ring-sizing fallback when the record cadence isn't supplied (manual `record(now)`
 *  without a hint). `allowRewindState` feeds the real sim interval, so this only
 *  matters for ad-hoc manual use. */
const DEFAULT_SAMPLE_INTERVAL_MS = 1000 / 60;

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

/** Options for {@link Rewind.get} / {@link Room.allowRewindState}. */
export interface RewindOptions {
  /** Default rewind window (ms) for attaches that don't pass their own — sizes the
   *  per-entity history ring. Per-attach `maxRewindMs` overrides it. Default 500. */
  maxRewindMs?: number;
  /** Default query DEPTH (ms) for attaches that don't pass their own — how far
   *  back a strict read ({@link RewindView.tryValue}) may aim before it rejects
   *  `too-old`. Per-attach `maxDepthMs` overrides it. Defaults to the group's
   *  retention (`maxRewindMs`): everything you keep is queryable. */
  maxDepthMs?: number;
}

/** Why a strict rewind refused to serve a past state — the OBSERVABLE boundary
 *  the lenient API (`at`/`value`) silently clamps or falls back past. */
export type RewindReject =
  /** `time <= 0`: the client's clock hasn't synced (no stamp to aim at). */
  | "not-synced"
  /** `time` is ahead of the server clock — client clock skew (or spoofing). */
  | "future"
  /** `time` is older than the covering group's `maxDepthMs` — a late input (or
   *  a spoofed stamp) asking for more history than the room allows. */
  | "too-old"
  /** Within the allowed depth, but no retained frame reaches back that far —
   *  the entity spawned later, or those frames were already evicted. */
  | "no-data"
  /** The entity (or field) has no recorded history at all. */
  | "untracked";

/** The failure half of every strict rewind result. */
export interface RewindRejection {
  ok: false;
  reason: RewindReject;
  /** The requested time (ms) that fell outside the window. */
  time: number;
  /** The window edge that rejected it: the now-ceiling (`future`), the depth
   *  floor `newest − maxDepthMs` (`too-old`), the oldest retained frame
   *  (`no-data`); `0` for `not-synced`, `NaN` for `untracked`. */
  bound: number;
}

/** A {@link RewindRejection} that names the field whose read was rejected. */
export interface RewindFieldRejection extends RewindRejection {
  field: string;
}

/** Strict aim result: an aimed view, or why the requested time was refused. */
export type RewindAimResult = { ok: true; view: RewindView } | RewindRejection;
/** Strict field-read result: the rewound value, or why it was refused. */
export type RewindValueResult = { ok: true; value: number } | RewindFieldRejection;

/** What a read actually used — inspect via {@link RewindView.debug} after any
 *  `value`/`read`/`tryValue`/`tryRead` call. */
export interface RewindReadDebug {
  /** The field that was read. */
  field: string;
  /** The raw requested time on that field's timeline (before any clamp). */
  requested: number;
  /** The time actually sampled, after every clamp (`NaN` when nothing was sampled). */
  at: number;
  /** The recorded frame at-or-before `at` — the frame the value came from
   *  (`NaN` when no history frame was used). */
  from: number;
  /** The next recorded frame after `at` (`=== from` when clamped to one frame). */
  to: number;
  /** `true` when `at` fell between `from` and `to` and the value was lerped. */
  interpolated: boolean;
  /** `true` when the read fell back to the live value (untracked entity/field). */
  live: boolean;
  /** Set when the last strict read rejected — see {@link RewindReject}. */
  reason?: RewindReject;
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
  /** How far back (ms before {@link newest}) a strict read may aim — the
   *  attach-group's `maxDepthMs` (defaults to its retention). */
  readonly maxDepthMs: number;
  /** Each tracked field's index into the entity's dense `$values` array —
   *  resolved per CONSTRUCTOR (mixed-type collections differ per type). */
  private readonly fieldIdx: readonly number[];
  private readonly cap: number;
  private readonly t: Float64Array;
  private readonly cols: Float64Array[];   // one column per field
  private readonly step: boolean;           // hold (vs lerp) between samples
  private head = 0;                         // next write slot
  private count = 0;

  constructor(fields: readonly string[], fieldIdx: readonly number[], maxRewindMs: number, sampleIntervalMs: number, step: boolean, reckoned: boolean, groupId: number, maxDepthMs: number) {
    this.fields = fields;
    this.fieldIdx = fieldIdx;
    this.step = step;
    this.reckoned = reckoned;
    this.groupId = groupId;
    this.maxDepthMs = maxDepthMs;
    this.cap = Math.max(2, Math.ceil(maxRewindMs / sampleIntervalMs) + 4);
    this.t = new Float64Array(this.cap);
    this.cols = fields.map(() => new Float64Array(this.cap));
  }

  /** `values` = the entity's dense `$values` array. Direct array reads — no
   *  per-field megamorphic accessor. */
  record(time: number, values: ArrayLike<number>): void {
    const fieldIdx = this.fieldIdx;
    this.t[this.head] = time;
    for (let f = 0; f < fieldIdx.length; f++) this.cols[f][this.head] = values[fieldIdx[f]];
    this.head = (this.head + 1) % this.cap;
    if (this.count < this.cap) this.count++;
  }

  /** Server time of the OLDEST retained frame. */
  get oldest(): number { return this.t[(this.head - this.count + this.cap) % this.cap]; }
  /** Server time of the NEWEST retained frame. */
  get newest(): number { return this.t[(this.head - 1 + this.cap) % this.cap]; }

  /** Interpolated value of column `col` at `time`, clamped to the retained range.
   *  When `dbg` is passed (a {@link RewindView}), the frame(s) actually used are
   *  reported into it for its `debug`/`describe()` output. */
  valueAt(time: number, col: number, dbg?: RewindView): number {
    const c = this.cols[col];
    const oldest = (this.head - this.count + this.cap) % this.cap;
    if (time <= this.t[oldest]) { dbg?._frames(this.t[oldest], this.t[oldest], false, this.t[oldest]); return c[oldest]; }
    const newest = (this.head - 1 + this.cap) % this.cap;
    if (time >= this.t[newest]) { dbg?._frames(this.t[newest], this.t[newest], false, this.t[newest]); return c[newest]; }
    let prev = oldest;
    for (let i = 1; i < this.count; i++) {
      const idx = (oldest + i) % this.cap;
      if (this.t[idx] >= time) {
        if (this.step) { dbg?._frames(this.t[prev], this.t[idx], false, this.t[prev]); return c[prev]; }   // discrete: hold the value before `time`
        const t0 = this.t[prev], t1 = this.t[idx];
        const a = t1 > t0 ? (time - t0) / (t1 - t0) : 0;
        dbg?._frames(t0, t1, true, time);
        return c[prev] + (c[idx] - c[prev]) * a;
      }
      prev = idx;
    }
    dbg?._frames(this.t[newest], this.t[newest], false, this.t[newest]);
    return c[newest];   // unreachable: `newest` guard above covers it
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

/** How `valueAt` reconstructs a value between recorded samples: `linear` interp
 *  (continuous motion) or `step` = hold the last sample (discrete motion). */
type Interp = "linear" | "step";

/** The strict per-field window check, shared by {@link RewindView.tryValue} and
 *  {@link Rewind.tryValueAt}: `raw` (the UNCLAMPED requested time on the field's
 *  timeline) against the history's own depth floor, retained range, and the
 *  now-ceiling. Returns the rejection, or undefined when `raw` is servable. */
function checkField(h: EntityHistory, field: string, raw: number, ceiling: number): RewindFieldRejection | undefined {
  if (raw <= 0) return { ok: false, reason: "not-synced", field, time: raw, bound: 0 };
  if (raw > ceiling) return { ok: false, reason: "future", field, time: raw, bound: ceiling };
  const newest = h.newest;
  const floor = newest - h.maxDepthMs;
  if (raw < floor) return { ok: false, reason: "too-old", field, time: raw, bound: floor };
  const oldest = h.oldest;
  if (raw < oldest) return { ok: false, reason: "no-data", field, time: raw, bound: oldest };
  return undefined;
}

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
 *
 * The lenient reads (`value`/`read`) clamp and fall back silently; the strict
 * reads ({@link tryValue}/{@link tryRead}) reject with an observable
 * {@link RewindReject} reason instead. After any read, {@link debug} /
 * {@link describe} report which history frame(s) actually served it.
 */
export class RewindView {
  /** Bound (and re-bound) by {@link _retarget} — a bare `new RewindView()` is
   *  un-aimed scratch until it first passes through at()/lastSeenBy(). */
  private rewind?: Rewind;
  private _time = 0;
  private _reckonTime = 0;
  /** The UNCLAMPED aim times, kept for the strict reads: the snapshot stamp as
   *  passed, and the reckon stamp as shipped (0 when none — a reconstructed
   *  reckon aim is a lenient-only fallback, see {@link tryValue}). */
  private _rawTime = 0;
  private _rawReckonStamp = 0;
  /** Debug slots for {@link debug}/{@link describe} — rewritten by every read,
   *  so they always describe the LAST one. */
  private _dbgAny = false;
  private _dbgField = "";
  private _dbgRequested = 0;
  private _dbgAt = NaN;
  private _dbgFrom = NaN;
  private _dbgTo = NaN;
  private _dbgInterp = false;
  private _dbgLive = false;
  private _dbgReason: RewindReject | undefined = undefined;

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
  _retarget(rewind: Rewind, at: number, reckonAt: number, rawTime: number, rawReckonStamp: number): this {
    this.rewind = rewind;
    this._time = at;
    this._reckonTime = reckonAt;
    this._rawTime = rawTime;
    this._rawReckonStamp = rawReckonStamp;
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
    this._dbgBegin(field, h !== undefined && h.reckoned ? this._rawReckonStamp : this._rawTime);
    if (h === undefined) { this._dbgLive = true; return (entity as Record<string, number>)[field]; }   // untracked → live
    return h.valueAt(h.reckoned ? this._reckonTime : this._time, h.fields.indexOf(field), this);
  }

  /**
   * Strict {@link value}: instead of clamping an out-of-window aim to whatever
   * old state happens to be retained, REJECTS observably — `{ ok: false, reason }`
   * names the boundary crossed ({@link RewindReject}): an unsynced stamp, a
   * future (skewed) one, a late input older than the covering group's
   * `maxDepthMs`, a frame the ring no longer holds, or an untracked field.
   * `mode:"reckon"` fields require the DIRECT reckon stamp (a reconstructed
   * midpoint aim is lenient-only) and reject `not-synced` without it.
   */
  tryValue<T extends object>(entity: T, field: NumericKeys<T>): RewindValueResult {
    if (this.rewind === undefined) {
      throw new Error("RewindView is not aimed — obtain it from rewind.at()/lastSeenBy(), or pass it to them as `out`.");
    }
    const h = historyForField(entity, field);
    const raw = h !== undefined && h.reckoned ? this._rawReckonStamp : this._rawTime;
    this._dbgBegin(field, raw);
    if (h === undefined) {
      this._dbgLive = true;
      return this._dbgReject({ ok: false, reason: "untracked", field, time: raw, bound: NaN });
    }
    const rej = checkField(h, field, raw, this.rewind._ceiling(h.newest));
    if (rej !== undefined) return this._dbgReject(rej);
    return { ok: true, value: h.valueAt(raw, h.fields.indexOf(field), this) };
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

  /** Strict {@link read}: the first field that rejects fails the batch — its
   *  rejection names that field. */
  tryRead<T extends object, F extends NumericKeys<T>, O extends Record<F, number> = Record<F, number>>(
    entity: T,
    fields: readonly F[],
    out?: O,
  ): { ok: true; value: O } | RewindFieldRejection {
    const o = (out ?? {}) as Record<F, number>;
    for (let i = 0; i < fields.length; i++) {
      const r = this.tryValue(entity, fields[i]);
      // (discriminant narrowing needs strictNullChecks — the cast is the else branch)
      if (r.ok) { o[fields[i]] = r.value; } else { return r as RewindFieldRejection; }
    }
    return { ok: true, value: o as O };
  }

  /** What the LAST read on this view actually used — the requested time, the
   *  clamped sample time, the recorded frame(s) it came from, and whether it
   *  lerped, held, fell back live, or was rejected. `undefined` before the
   *  first read. Allocate-on-access: reading this is for logging/debugging,
   *  not the per-tick hot path. */
  get debug(): RewindReadDebug | undefined {
    if (!this._dbgAny) return undefined;
    const d: RewindReadDebug = {
      field: this._dbgField, requested: this._dbgRequested, at: this._dbgAt,
      from: this._dbgFrom, to: this._dbgTo, interpolated: this._dbgInterp, live: this._dbgLive,
    };
    if (this._dbgReason !== undefined) d.reason = this._dbgReason;
    return d;
  }

  /** One human-readable line describing the last read — for logs and hit-reg
   *  diagnostics: which history frame(s) served it, or why none did. */
  describe(): string {
    if (!this._dbgAny) return "rewind: no read yet";
    const r = (n: number) => Math.round(n * 1e3) / 1e3;
    const req = `requested ${r(this._dbgRequested)}`;
    if (this._dbgReason !== undefined) return `rewind ${this._dbgField}: REJECTED ${this._dbgReason} (${req})`;
    if (this._dbgLive) return `rewind ${this._dbgField}: LIVE, untracked (${req})`;
    if (this._dbgInterp) return `rewind ${this._dbgField}: lerp frames [${r(this._dbgFrom)}..${r(this._dbgTo)}] @ ${r(this._dbgAt)} (${req})`;
    if (this._dbgFrom === this._dbgTo) return `rewind ${this._dbgField}: frame ${r(this._dbgFrom)} (${req} → ${r(this._dbgAt)})`;
    return `rewind ${this._dbgField}: hold frame ${r(this._dbgFrom)}, next ${r(this._dbgTo)} (${req} → ${r(this._dbgAt)})`;
  }

  /** @internal Reset the debug slots for a new read (called by every read verb). */
  private _dbgBegin(field: string, requested: number): void {
    this._dbgAny = true;
    this._dbgField = field;
    this._dbgRequested = requested;
    this._dbgAt = NaN;
    this._dbgFrom = NaN;
    this._dbgTo = NaN;
    this._dbgInterp = false;
    this._dbgLive = false;
    this._dbgReason = undefined;
  }

  /** @internal Record a strict rejection into the debug slots, then return it. */
  private _dbgReject<R extends RewindFieldRejection>(rej: R): R {
    this._dbgReason = rej.reason;
    return rej;
  }

  /** @internal {@link EntityHistory.valueAt} reports the frame(s) it used. */
  _frames(from: number, to: number, interpolated: boolean, at: number): void {
    this._dbgFrom = from;
    this._dbgTo = to;
    this._dbgInterp = interpolated;
    this._dbgAt = at;
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
  /** History RETENTION (ms) — sizes each entity's ring. A per-entity fn picks
   *  it per type (mirroring `interpolate`'s fn form). */
  maxRewindMs: number | ((entity: any) => number);
  /** Query DEPTH (ms) for strict reads, or undefined to track the retention
   *  (everything kept is queryable). A per-entity fn picks it per type. */
  maxDepthMs: number | ((entity: any) => number) | undefined;
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
  /** History RETENTION (ms): how long frames are kept. A per-entity fn picks it
   *  per type within one collection. Default: the Rewind's `maxRewindMs`. */
  maxRewindMs?: number | ((entity: E) => number);
  /** Query DEPTH (ms): how far back a STRICT read ({@link RewindView.tryValue})
   *  may aim before it rejects `too-old` — the room's anti-spoof / late-input
   *  bound, independent of how much history is retained. A per-entity fn picks
   *  it per type. Default: the Rewind's `maxDepthMs`, else the retention. */
  maxDepthMs?: number | ((entity: E) => number);
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
 * The rewind WINDOW is configured per attach-group: `maxRewindMs` (retention —
 * how long frames are kept) and `maxDepthMs` (query depth — how far back a
 * strict read may aim), each a number or a per-entity fn. Reads come in two
 * flavors: lenient ({@link at}/{@link lastSeenBy}/{@link valueAt} — clamp +
 * live-fallback baked in) and strict ({@link tryAt}/{@link tryLastSeenBy}/
 * {@link tryValueAt} + {@link RewindView.tryValue} — out-of-window aims reject
 * with an observable {@link RewindReject} reason instead of reading arbitrary
 * old state).
 */
export class Rewind {
  private static readonly byRoom = new WeakMap<object, Rewind>();

  /** One `Rewind` per room (idempotent). `room` is only the cache key. */
  static get(room: object, opts?: RewindOptions): Rewind {
    let r = Rewind.byRoom.get(room);
    if (r === undefined) { r = new Rewind(opts?.maxRewindMs ?? DEFAULT_MAX_REWIND_MS, opts?.maxDepthMs); Rewind.byRoom.set(room, r); }
    return r;
  }

  private readonly groups: TrackedGroup[] = [];
  private readonly defaultMaxRewindMs: number;
  /** Default query depth for attaches that don't set their own — `undefined`
   *  means "track the retention" (see {@link RewindOptions.maxDepthMs}). */
  private readonly defaultMaxDepthMs: number | undefined;
  /** Deepest retention any attached group keeps (≥ defaultMaxRewindMs) — the
   *  floor of the aim window, so a group retaining MORE than the default is
   *  actually reachable by `at()`. Grows as groups attach. */
  private _maxWindowMs: number;
  private _sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS;
  private _lastRecordedAt = -1;
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

  private constructor(defaultMaxRewindMs: number, defaultMaxDepthMs: number | undefined) {
    this.defaultMaxRewindMs = defaultMaxRewindMs;
    this.defaultMaxDepthMs = defaultMaxDepthMs;
    this._maxWindowMs = defaultMaxRewindMs;
  }

  /** The default rewind window (ms). Use it to bound a hit test:
   *  `Math.max(renderTime, now - rewind.maxRewindMs)`. */
  get maxRewindMs(): number { return this.defaultMaxRewindMs; }
  /** The default query depth (ms) for strict reads — the Rewind-level
   *  `maxDepthMs` when set, else the retention default. */
  get maxDepthMs(): number { return this.defaultMaxDepthMs ?? this.defaultMaxRewindMs; }
  /** Server time of the last {@link record} (or -1). The auto-record skips a tick
   *  whose time was already recorded manually — your `record()` wins. */
  get lastRecordedAt(): number { return this._lastRecordedAt; }

  /** Track every entity in a collection (Map/Array/Set schema). `fields` narrows
   *  to its element's numeric fields. `interpolate` (a mode or a per-entity fn,
   *  default `linear`) picks how `valueAt` reconstructs between samples — use
   *  `step` for discrete-motion entities (e.g. teleporters). `mode` picks the
   *  lag-comp timeline (default `"snapshot"`; see {@link AttachOptions}).
   *  `maxRewindMs` / `maxDepthMs` (numbers or per-entity fns) set the group's
   *  retention and strict query depth. */
  attachAll<E extends object>(
    collection: Collection<E>,
    opts: AttachOptions<E>,
  ): this {
    const c = collection as unknown as { values(): Iterable<object> };
    this.pushGroup({ entities: () => c.values(), fields: opts.fields, resolvedByCtor: new Map(), maxRewindMs: opts.maxRewindMs ?? this.defaultMaxRewindMs, maxDepthMs: opts.maxDepthMs ?? this.defaultMaxDepthMs, interpolate: opts.interpolate ?? "linear", reckoned: opts.mode === "reckon", groupId: this.groups.length });
    return this;
  }

  /** Track a single entity (e.g. a boss). `fields` narrows to its numeric fields. */
  attach<E extends object>(instance: E, opts: AttachOptions<E>): this {
    const one: object[] = [instance];   // reused; no per-tick alloc
    this.pushGroup({ entities: () => one, fields: opts.fields, resolvedByCtor: new Map(), maxRewindMs: opts.maxRewindMs ?? this.defaultMaxRewindMs, maxDepthMs: opts.maxDepthMs ?? this.defaultMaxDepthMs, interpolate: opts.interpolate ?? "linear", reckoned: opts.mode === "reckon", groupId: this.groups.length });
    return this;
  }

  /** Register a group and widen the aim-window floor to its retention (fn-form
   *  retention can't be known per-type up front — the default stands in). */
  private pushGroup(g: TrackedGroup): void {
    this.groups.push(g);
    const retention = g.maxRewindMs;
    this._maxWindowMs = Math.max(this._maxWindowMs, typeof retention === "number" ? retention : this.defaultMaxRewindMs);
  }

  /**
   * Snapshot every tracked entity at `now`. Call once per tick, AFTER they move —
   * {@link Room.allowRewindState} does this for you. `sampleIntervalMs` (the gap
   * between records) sizes the history rings; the framework passes the sim
   * interval. Calling this yourself during a tick suppresses that tick's
   * auto-record (see {@link lastRecordedAt}).
   *
   * Commits are MONOTONIC: a `now` at-or-before {@link lastRecordedAt} is a
   * duplicate or late frame and is dropped (`false` returned) — history commit
   * order always matches the server frame order, and the same frame is never
   * recorded twice. Returns `true` when the frame was committed.
   */
  record(now: number, sampleIntervalMs?: number): boolean {
    if (now <= this._lastRecordedAt) return false;   // duplicate/late frame — commit order stays server-frame order
    if (sampleIntervalMs !== undefined && sampleIntervalMs > 0) this._sampleIntervalMs = sampleIntervalMs;
    this._lastRecordedAt = now;
    for (const g of this.groups) {
      for (const e of g.entities()) {
        const t = e as any;   // private-symbol access on a foreign schema instance
        let arr = t[$HISTORY] as EntityHistories | undefined;
        if (arr === undefined) { arr = []; t[$HISTORY] = arr; }
        let h: EntityHistory | undefined;
        for (let i = 0; i < arr.length; i++) { if (arr[i].groupId === g.groupId) { h = arr[i]; break; } }
        if (h === undefined) { h = this.createHistory(g, e); arr.push(h); }   // cold: once per (entity, group)
        h.record(now, t[$values] as ArrayLike<number>);
      }
    }
    return true;
  }

  /** Cold path — first time an entity is seen by `record()` for a given group.
   *  Resolves the field→`$values` indices (cached per constructor for array-form
   *  `fields`; fn-form resolves per entity) and bakes in the group's `mode`. */
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
    const interp = typeof g.interpolate === "function" ? g.interpolate(e) : g.interpolate;
    // Retention and depth resolve PER ENTITY (fn form picks per type); depth
    // defaults to the retention — everything kept is queryable.
    const retention = typeof g.maxRewindMs === "function" ? g.maxRewindMs(e) : g.maxRewindMs;
    const depth = g.maxDepthMs === undefined ? retention : (typeof g.maxDepthMs === "function" ? g.maxDepthMs(e) : g.maxDepthMs);
    return new EntityHistory(rf.fields, rf.idx, retention, this._sampleIntervalMs, interp === "step", g.reckoned, g.groupId, depth);
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
   * isn't tracked.
   */
  valueAt<T extends object>(instance: T, time: number, field: NumericKeys<T>): number {
    const h = historyForField(instance, field);
    if (h === undefined) return (instance as Record<string, number>)[field];
    return h.valueAt(time, h.fields.indexOf(field));
  }

  /**
   * Strict {@link valueAt} — the single-target call style with observable
   * bounds: instead of clamping an out-of-window `time` to whatever old state
   * happens to be retained, REJECTS with the boundary crossed
   * ({@link RewindReject}). `time` is the stamp on the field's own timeline
   * (a renderTime for `mode:"snapshot"` groups, a reckonTime for `"reckon"`).
   */
  tryValueAt<T extends object>(instance: T, time: number, field: NumericKeys<T>): RewindValueResult {
    const rej = this._checkTime(time);
    if (rej !== undefined) return { ...rej, field };
    const h = historyForField(instance, field);
    if (h === undefined) return { ok: false, reason: "untracked", field, time, bound: NaN };
    const frej = checkField(h, field, time, this._ceiling(h.newest));
    if (frej !== undefined) return frej;
    return { ok: true, value: h.valueAt(time, h.fields.indexOf(field)) };
  }

  /** @internal The upper edge a requested time may not pass: the bound server
   *  "now" when wired ({@link bindNow}), else `fallback` (the newest record). */
  _ceiling(fallback: number): number {
    return this._nowOf !== undefined ? this._nowOf() : fallback;
  }

  /** The aim-level window gate shared by the strict verbs: is `time` a servable
   *  stamp at all (synced, not from the future, not older than the deepest
   *  retention any group keeps)? Per-group depth is enforced per READ. */
  private _checkTime(time: number): RewindRejection | undefined {
    if (time <= 0) return { ok: false, reason: "not-synced", time, bound: 0 };
    const ceiling = this._ceiling(this._lastRecordedAt);
    if (time > ceiling) return { ok: false, reason: "future", time, bound: ceiling };
    const floor = this._lastRecordedAt - this._maxWindowMs;
    if (time < floor) return { ok: false, reason: "too-old", time, bound: floor };
    return undefined;
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
   *  - **clamp** to `[lastRecordedAt − window, lastRecordedAt]` (the window is
   *    the deepest retention any attached group keeps) — an anti-spoof /
   *    clock-skew bound (a client can't rewind arbitrarily far), and
   *  - **live fallback**: `time <= 0` (the client's clock hasn't synced) → the
   *    newest recorded sample (≈ current position).
   *
   * The clamp is SILENT — a hit test that must KNOW when a stamp fell outside
   * the window (late input, skewed clock, missing frames) uses {@link tryAt} +
   * {@link RewindView.tryValue}, which reject with an observable reason instead.
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
   * Strict {@link at}: refuses an aim the lenient API would silently clamp —
   * an unsynced stamp (`not-synced`), a skewed-ahead one (`future`), or one
   * older than the deepest retention any attached group keeps (`too-old`,
   * e.g. a late input). Per-group `maxDepthMs` and per-entity coverage are
   * enforced per READ — follow up with {@link RewindView.tryValue}.
   */
  tryAt(time: number, out?: RewindView): RewindAimResult {
    const rej = this._checkTime(time);
    if (rej !== undefined) return rej;
    return { ok: true, view: this._aim(time, 0, out) };
  }

  /**
   * Strict {@link lastSeenBy}: validates the stamp(s) the attached groups
   * actually read — a snapshot group's renderTime, a reckon group's reckonTime —
   * and rejects observably when the acting client's stamp is unsynced, skewed
   * into the future, or too old to serve (a late input), instead of falling
   * back to live positions or clamping to arbitrary old state.
   */
  tryLastSeenBy(sessionId: string, out?: RewindView): RewindAimResult {
    const renderTimeOf = this._requireStamps();
    const renderTime = renderTimeOf(sessionId);
    const reckonTime = this._reckonTimeOf !== undefined ? this._reckonTimeOf(sessionId) : 0;
    const mode = this.timelineMode();
    if (mode.snapshot) {
      const rej = this._checkTime(renderTime);
      if (rej !== undefined) return rej;
    }
    if (mode.reckon) {
      // A reckon group's aim is its DIRECT stamp — an unstamped client would
      // silently engage the midpoint reconstruction, which strict mode refuses.
      const rej = this._checkTime(reckonTime);
      if (rej !== undefined) return rej;
    }
    return { ok: true, view: this._aim(renderTime, reckonTime, out) };
  }

  /**
   * Shared aiming: clamp the snapshot-timeline `time`, and resolve the reckon
   * timeline either from the DIRECT `reckonStamp` (the instant the client's
   * forward-reckoned entities were displayed at — exact, immune to the
   * client's RTT-estimation error) or, when absent (0), by reconstruction.
   */
  private _aim(time: number, reckonStamp: number, out?: RewindView): RewindView {
    const newest = this._lastRecordedAt;
    const oldest = newest - this._maxWindowMs;
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
    return (out ?? this._view)._retarget(this, at, reckonAt, time, reckonStamp);
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
    const renderTimeOf = this._requireStamps();
    return this._aim(
      renderTimeOf(sessionId),
      this._reckonTimeOf !== undefined ? this._reckonTimeOf(sessionId) : 0,
      out,
    );
  }

  /** The render-time resolver, or a loud throw when the room never wired the
   *  framework input API — a missing resolver is a CONFIG error (unlike an
   *  unstamped client, which legitimately reads 0 → live fallback). */
  private _requireStamps(): (sessionId: string) => number {
    if (this._renderTimeOf === undefined) {
      throw new Error(
        "Rewind.lastSeenBy(sessionId) needs the framework input API. Declare " +
        "`this.defineInput(Input)` (stamps auto-enable from your attachAll `mode`), " +
        "or call `at(time)` and pass the render time yourself.",
      );
    }
    return this._renderTimeOf;
  }
}
