function nodeIds(nodes) {
  return new Set(nodes.map((node) => node.id));
}

export function validate(nodes) {
  const problems = [];
  const seen = new Set();
  const ids = nodeIds(nodes);

  for (const node of nodes) {
    if (seen.has(node.id)) {
      problems.push(`duplicate id: ${node.id}`);
    }
    seen.add(node.id);

    for (const dependency of node.deps) {
      if (dependency === node.id) {
        problems.push(`self-dependency: ${node.id}`);
      } else if (!ids.has(dependency)) {
        problems.push(`unknown dependency: ${node.id} -> ${dependency}`);
      }
    }
  }

  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === "visiting") return true;
    if (state.get(id) === "visited") return false;

    state.set(id, "visiting");
    const node = nodes.find((candidate) => candidate.id === id);
    const hasCycle = node.deps.some((dependency) => ids.has(dependency) && visit(dependency));
    state.set(id, "visited");
    return hasCycle;
  };

  if (nodes.some((node) => visit(node.id))) {
    problems.push("cycle detected");
  }

  return problems;
}

export function topoSort(nodes) {
  const problems = validate(nodes);
  if (problems.length > 0) {
    throw new Error(problems.join("; "));
  }

  const completed = new Set();
  const levels = [];
  while (completed.size < nodes.length) {
    const level = nodes
      .filter((node) => !completed.has(node.id) && node.deps.every((dependency) => completed.has(dependency)))
      .map((node) => node.id);

    if (level.length === 0) {
      throw new Error("cycle detected");
    }
    levels.push(level);
    level.forEach((id) => completed.add(id));
  }
  return levels;
}

export function readyNodes(nodes, doneIds) {
  const done = new Set(doneIds);
  return nodes
    .filter((node) => !done.has(node.id) && node.deps.every((dependency) => done.has(dependency)))
    .map((node) => node.id);
}
