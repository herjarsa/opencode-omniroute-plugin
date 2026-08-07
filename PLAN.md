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
