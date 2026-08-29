import assert from "node:assert/strict";
import test from "node:test";
import { readyNodes, topoSort, validate } from "../src/dag.js";

const nodes = [
  { id: "build", deps: ["compile", "lint"] },
  { id: "compile", deps: ["install"] },
  { id: "lint", deps: ["install"] },
  { id: "install", deps: [] },
];

test("validates a graph and returns deterministic execution levels", () => {
  assert.deepEqual(validate(nodes), []);
  assert.deepEqual(topoSort(nodes), [["install"], ["compile", "lint"], ["build"]]);
});

test("reports duplicate IDs", () => {
  assert.deepEqual(validate([{ id: "a", deps: [] }, { id: "a", deps: [] }]), ["duplicate id: a"]);
});

test("reports self-dependencies", () => {
  assert.deepEqual(validate([{ id: "a", deps: ["a"] }]), ["self-dependency: a", "cycle detected"]);
});

test("reports unknown dependencies", () => {
  assert.deepEqual(validate([{ id: "a", deps: ["missing"] }]), ["unknown dependency: a -> missing"]);
});

test("reports cycles", () => {
  assert.deepEqual(validate([
    { id: "a", deps: ["b"] },
    { id: "b", deps: ["a"] },
  ]), ["cycle detected"]);
});

test("rejects invalid graphs in topoSort", () => {
  assert.throws(() => topoSort([{ id: "a", deps: ["missing"] }]), /unknown dependency: a -> missing/);
});

test("progresses ready nodes and excludes completed IDs", () => {
  assert.deepEqual(readyNodes(nodes, []), ["install"]);
  assert.deepEqual(readyNodes(nodes, ["install"]), ["compile", "lint"]);
  assert.deepEqual(readyNodes(nodes, ["install", "compile"]), ["lint"]);
  assert.deepEqual(readyNodes(nodes, ["install", "compile", "lint"]), ["build"]);
  assert.deepEqual(readyNodes(nodes, ["install", "compile", "lint", "build"]), []);
});
