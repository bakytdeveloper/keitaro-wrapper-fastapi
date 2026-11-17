import test from "node:test";
import assert from "node:assert/strict";
import { formatStreamFilters } from "./formatters.js";

test("formats array and scalar Keitaro filter payloads", () => {
  assert.equal(formatStreamFilters([
    { name: "country", mode: "accept", payload: ["AU", "MX"] },
    { name: "device", mode: "reject", payload: "mobile" },
  ]), "country accept AU, MX; device reject mobile");
});

test("formats nested payloads and tolerates malformed filter containers", () => {
  assert.equal(formatStreamFilters([
    { name: "custom", operator: "include", payload: { values: ["a", "b"], enabled: true } },
  ]), "custom include values: a, b, enabled: true");
  assert.equal(formatStreamFilters(null), "");
  assert.equal(formatStreamFilters({ name: "country", payload: "AU" }), "");
});
