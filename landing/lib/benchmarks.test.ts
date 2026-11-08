import assert from "node:assert/strict";
import test from "node:test";
import { answerBenchmarks, dracoRows, sourceMetrics } from "./benchmarks.ts";

test("benchmark charts keep team-supplied scores separate from external evaluation results", () => {
  for (const rows of [...answerBenchmarks.map(item => item.rows), dracoRows]) {
    assert.equal(new Set(rows.map(row => row.name)).size, rows.length);
    assert.equal(rows.filter(row => row.source === "team").length, 1);
    for (const row of rows) {
      assert.ok(Number.isFinite(row.score) && row.score >= 0 && row.score <= 100);
      assert.equal(row.source === "team", row.name === "TraceDog");
    }
  }
  assert.ok(!dracoRows.some(row => /hyperresearch/i.test(row.name)));
  assert.equal(dracoRows.find(row => row.name === "TraceDog")?.score, 74.8);
  assert.equal(dracoRows.find(row => row.name === "TraceDog")?.tasks, "10 of 10");
  for (const chart of answerBenchmarks) {
    assert.equal(chart.rows.find(row => row.source === "team")?.score, chart.score);
  }
});

test("source-count charts distinguish missing reference data from measured zero", () => {
  for (const metric of sourceMetrics) {
    assert.equal(metric.rows.find(row => row.source === "team")?.count, metric.count);
    assert.ok(metric.rows.every(row => row.count === null || (Number.isFinite(row.count) && row.count > 0)));
    assert.ok(Math.max(...metric.rows.map(row => row.count ?? 0)) > 0);
    assert.ok(!metric.rows.some(row => /hyperresearch/i.test(row.name)));
    assert.equal(new Set(metric.rows.map(row => row.name)).size, metric.rows.length);
    assert.ok(!/next run|vault/i.test(metric.description));
  }
  for (const id of ["checked", "captured"]) {
    const rows = sourceMetrics.find(metric => metric.id === id)!.rows;
    assert.equal(rows.filter(row => row.count === null).length, 3);
    assert.ok(rows.filter(row => row.count === null).every(row => row.source === "reference"));
  }
});
