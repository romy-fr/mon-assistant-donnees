// Tests de la garde par créneau : node --test scripts/lib/guard.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { latestSlot, shouldRun } from "./guard.mjs";

const LOIS = { hours: [8, 14, 20], weekendHours: [14] };
const at = (iso) => new Date(iso);

test("hiver et été : le créneau suit l'heure de Paris", () => {
  assert.equal(latestSlot({ hours: [0] }, at("2026-11-24T23:20:00Z")), "2026-11-25T00");
  assert.equal(latestSlot({ hours: [0] }, at("2026-07-14T22:20:00Z")), "2026-07-15T00");
});

test("Lois : avant 8 h on est encore sur la veille au soir", () => {
  assert.equal(latestSlot(LOIS, at("2026-11-25T06:05:00Z")), "2026-11-24T20"); // 7 h 05 à Paris
  assert.equal(latestSlot(LOIS, at("2026-11-25T07:05:00Z")), "2026-11-25T08");
});

test("Lois : le week-end, seulement 14 h", () => {
  assert.equal(latestSlot(LOIS, at("2026-11-28T09:00:00Z")), "2026-11-27T20"); // samedi matin
  assert.equal(latestSlot(LOIS, at("2026-11-28T20:00:00Z")), "2026-11-28T14");
});

test("hebdomadaire et mensuel", () => {
  assert.equal(latestSlot({ hours: [7], weekdays: [1] }, at("2026-11-30T05:35:00Z")), "2026-11-23T07"); // lundi 6 h 35
  assert.equal(latestSlot({ hours: [7], weekdays: [1] }, at("2026-12-01T15:00:00Z")), "2026-11-30T07");
  assert.equal(latestSlot({ hours: [5], monthDays: [1] }, at("2026-12-31T12:00:00Z")), "2026-12-01T05");
});

test("un passage très en retard est exécuté une seule fois", () => {
  delete process.env.FORCE;
  const dir = mkdtempSync(join(tmpdir(), "garde-"));
  const run = (iso) => shouldRun("lois", LOIS, { now: at(iso), dir });
  assert.equal(run("2026-11-25T10:40:00Z"), true); // créneau de 8 h avec plus de 3 h de retard
  assert.equal(run("2026-11-25T11:05:00Z"), false);
  assert.equal(run("2026-11-25T13:05:00Z"), true); // créneau de 14 h
  assert.equal(run("2026-11-25T14:05:00Z"), false);
});

test("FORCE exécute sans noter le créneau", () => {
  const dir = mkdtempSync(join(tmpdir(), "garde-"));
  process.env.FORCE = "1";
  assert.equal(shouldRun("climat", { hours: [0] }, { now: at("2026-11-25T12:00:00Z"), dir }), true);
  delete process.env.FORCE;
  assert.equal(shouldRun("climat", { hours: [0] }, { now: at("2026-11-25T12:00:00Z"), dir }), true);
});
