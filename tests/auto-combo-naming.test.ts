/**
 * Auto combo display-name contract.
 *
 * Display names MUST be derived from the literal catalog id — never from the
 * server-side `name` field (which shortens, e.g. "Auto Chaos" for
 * auto/best-chaos) and never from the variant alone (which collapses the
 * whole best/pro/claude family to "Auto: Default" because those
 * entries carry an empty variant on the regenerated catalog).
 *
 * Spec:
 *   - "auto"             → "Auto Default"
 *   - "auto/coding"      → "Auto Coding"
 *   - "auto/best-chaos"  → "Auto Best Chaos"
 *   - "auto/pro-fast"    → "Auto Pro Fast"
 *   - "auto/coding:fast" → "Auto Coding Fast"
 * No candidate-count suffix — the provider pool size is server-internal
 * detail, not part of the display name.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  formatAutoComboName,
  autoComboModelId,
} from "../src/naming.js";
import { mapAutoComboToStaticEntry } from "../src/index.js";
import type { OmniRouteRawAutoCombo } from "../src/index.js";

test("formatAutoComboName derives the label from the literal catalog id", () => {
  assert.equal(formatAutoComboName(undefined, undefined, "auto"), "Auto Default");
  assert.equal(formatAutoComboName(undefined, undefined, "auto/coding"), "Auto Coding");
  assert.equal(
    formatAutoComboName(undefined, undefined, "auto/best-chaos"),
    "Auto Best Chaos",
  );
  assert.equal(
    formatAutoComboName(undefined, undefined, "auto/pro-fast"),
    "Auto Pro Fast",
  );
  assert.equal(
    formatAutoComboName(undefined, undefined, "auto/coding:fast"),
    "Auto Coding Fast",
  );
});

test("formatAutoComboName ignores the candidate count", () => {
  assert.equal(
    formatAutoComboName(undefined, 5, "auto/best-chaos"),
    "Auto Best Chaos",
  );
});

test("formatAutoComboName falls back to the variant label without a catalog id", () => {
  assert.equal(formatAutoComboName("coding", 5), "Auto Coding");
  assert.equal(formatAutoComboName(undefined), "Auto Default");
});
test("mapAutoComboToStaticEntry uses the catalog-derived name", () => {
  const raw = {
    id: "auto/best-chaos",
    name: "Auto Chaos", // server-side short name must be ignored
    candidateCount: 5,
  } as OmniRouteRawAutoCombo;
  const entry = mapAutoComboToStaticEntry(raw);
  assert.equal(entry.name, "Auto Best Chaos");
});

test("autoComboModelId keeps the full catalog id for best-* family", () => {
  assert.equal(autoComboModelId(undefined, "auto/best-chaos"), "auto/best-chaos");
  assert.equal(autoComboModelId(undefined, "auto"), "auto");
  assert.equal(autoComboModelId("coding", undefined), "auto/coding");
  assert.equal(autoComboModelId(undefined, undefined), "auto");
});
