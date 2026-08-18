# PLAN — Fork: LCD context windows from upstream (min of members)

**Repo**: herjarsa/opencode-omniroute-plugin (base: official v0.2.1, npm/tsup)
**Goal**: OpenCode stops showing context 0 for OmniRoute models/combos.

## Spec (user)

> El plugin extrae las ventanas de contexto de cada modelo del upstream y hace
> el cálculo en los combos y combos anidados en base al modelo de menor
> contexto: ese es el valor que tomará el combo.

- Model → `limit.context` = upstream `context_length`.
- Combo → `limit.context` = MIN(`context_length`) over resolved members
  (combo-refs resolve to their own min first).
- `output` is required by OC's static-catalog schema whenever `limit` is
  present; when upstream omits `max_output_tokens`, derive
  `output = min(context, FALLBACK_OUTPUT_TOKENS)` (8_192, same value the
  plugin already uses for auto combos).

## Root cause (verified empirically on runtime 3.8.49)

`buildStaticProviderEntry` gated `limit` emission on BOTH
`context_length > 0` AND `max_output_tokens > 0`:

- runtime exposes 762 models: 752 with `context_length > 0`, only 159 with
  `max_output_tokens > 0` → 321/434 catalog models emitted WITHOUT `limit`
  → OpenCode showed context 0.
- same gate on the combo branch (`contextValues.length > 0 &&
  outputValues.length > 0`) → `stack-free` / `opencode-free` combos lost
  their `limit` entirely.

## Tasks

1. [x] Base: copy official v0.2.1 source → local repo, git init, adapt
       CI/release workflows to npm/tsup, force-push base (d142b84).
2. [x] RED: `tests/context-lcd.test.ts` (9 tests) — models without output,
       combos min-of-members without outputs, nested combo-refs (1 and 2
       levels), both-fields regression, no-limit regression, constant sanity.
3. [x] GREEN: fix in `src/index.ts`:
       - export `FALLBACK_OUTPUT_TOKENS = AUTO_COMBO_FALLBACK_OUTPUT` (8_192);
       - model branch: emit `limit` when `context_length > 0`, derive output;
       - combo branch: emit `limit` when any member has context, min over
         members, derive output when no member declares `max_output_tokens`.
4. [x] Build (`tsup`) + full suite: 295 pass / 0 fail / 1 skip (pre-existing).
5. [ ] Empirical verification: harness against live runtime (was 321/434
       models without context → expect 0).
6. [ ] Install fixed `dist/` into `~/.config/opencode/plugins/omniroute`.
7. [ ] Commit + push.

## Files touched

- `src/index.ts` (2 gates + 1 export)
- `tests/context-lcd.test.ts` (new)
- `package.json` (test script list)

---

# PLAN — features.enabledOnly (provider-level active filter)

**Repo**: herjarsa/opencode-omniroute-plugin
**Goal**: Add an opt-in feature flag that filters `/v1/models` to providers with `isActive: true` in `/api/providers`, **ignoring `testStatus`**.

## User motivation

The existing `usableOnly` filter requires BOTH `isActive: true` AND `testStatus: "active"`. This is too strict for operators who want the model picker to mirror the OmniRoute dashboard's enable/disable switch (a UI toggle, persisted across restarts) instead of being coupled to the transient `testStatus` field (which flips to `unavailable`/`expired` for rate-limited or temporarily-broken providers the operator still wants visible).

Combos and auto-combos have no enable/disable in the OmniRoute dashboard, so they always pass through.

## Decision

- **New opt-in flag `features.enabledOnly`, default-OFF** (no breaking change to existing configs).
- Uses the same `rawConnections` fetch as `usableOnly` — no additional network round-trip.
- `enabledProviderAliasSet` mirrors `usableProviderAliasSet` MINUS the `testStatus` gate. Same subtract-filter semantics.
- `isEnabledRawModelId` is identical to `isUsableRawModelId` (re-uses the same shape and verdict logic).
- **Combos always pass through** — no filter applied to combo entries (their provider membership doesn't matter for this filter).
- Soft-fail: empty connections OR fetch throws → `enabledProviderSet` is undefined → filter disabled for the refresh, never hides the whole catalog.
- Disk snapshot round-trips `enabledProviderSet` for offline resilience (matches the `activeModelIds` pattern).
- Co-existence with `usableOnly`: when BOTH are on, the INTERSECTION applies — usableOnly's stricter testStatus check wins per provider.

## Files touched

- `src/index.ts`:
  - `featuresSchema` (added `enabledOnly`)
  - `OMNIROUTE_FEATURE_DEFAULTS` (added `enabledOnly: false`)
  - New exports `enabledProviderAliasSet`, `isEnabledRawModelId`
  - `OmniRouteFetchCacheEntry.enabledProviderSet` (new field)
  - `OmniRouteDiskSnapshot.enabledProviderSet` (new field)
  - `defaultDiskSnapshotWriter` / `defaultDiskSnapshotReader` (round-trip the new field)
  - `forceSyncOmniRouteModels`, `createOmniRouteProviderHook`, `createOmniRouteConfigHook`: feature flag read + connections fetch gate (now fires when `wantUsableOnly || wantEnabledOnly`) + cache entry write
  - `buildStaticProviderEntry`: filter application after the `usableOnly` filter
- `tests/enabled-only.test.ts` (NEW): 10 tests (forceSync cache + soft-fail, snapshot round-trip, provider hook filtering, config hook filtering, catalog stability, enabledOnly+usableOnly intersection)
- `package.json`: added `tests/enabled-only.test.ts` to `npm test`
- `README.md`: features table row + example block + comparison with `usableOnly`
