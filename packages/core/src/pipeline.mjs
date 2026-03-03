export class PipelineRegistry {
  constructor() {
    this._steps = new Map();
  }

  register(name, step) {
    if (!step || typeof step.run !== "function") {
      throw new Error(`Pipeline step "${name}" must have a run() function`);
    }
    this._steps.set(name, {
      name,
      description: step.description || "",
      run: step.run,
      after: step.after || [],
      before: step.before || []
    });
  }

  unregister(name) {
    this._steps.delete(name);
  }

  has(name) {
    return this._steps.has(name);
  }

  list() {
    return Array.from(this._steps.values()).map((s) => ({
      name: s.name,
      description: s.description,
      after: s.after,
      before: s.before
    }));
  }

  _topoSort() {
    const steps = Array.from(this._steps.values());
    const nameSet = new Set(steps.map((s) => s.name));
    const adj = new Map();
    const inDeg = new Map();
    for (const s of steps) {
      adj.set(s.name, []);
      inDeg.set(s.name, 0);
    }
    for (const s of steps) {
      for (const dep of s.after) {
        if (nameSet.has(dep)) {
          adj.get(dep).push(s.name);
          inDeg.set(s.name, inDeg.get(s.name) + 1);
        }
      }
      for (const target of s.before) {
        if (nameSet.has(target)) {
          adj.get(s.name).push(target);
          inDeg.set(target, inDeg.get(target) + 1);
        }
      }
    }
    const queue = [];
    for (const [name, deg] of inDeg) {
      if (deg === 0) {
        queue.push(name);
      }
    }
    const sorted = [];
    while (queue.length) {
      queue.sort();
      const current = queue.shift();
      sorted.push(current);
      for (const next of adj.get(current) || []) {
        inDeg.set(next, inDeg.get(next) - 1);
        if (inDeg.get(next) === 0) {
          queue.push(next);
        }
      }
    }
    if (sorted.length !== steps.length) {
      throw new Error("Pipeline has circular dependencies");
    }
    return sorted.map((name) => this._steps.get(name));
  }

  async runAll(pipelineCtx) {
    const ordered = this._topoSort();
    const results = [];
    for (const step of ordered) {
      const startedAt = new Date().toISOString();
      try {
        const result = await step.run(pipelineCtx);
        results.push({ name: step.name, status: "ok", startedAt, result });
      } catch (err) {
        results.push({ name: step.name, status: "failed", startedAt, error: err.message });
        throw err;
      }
    }
    return results;
  }
}

export function createPipelineRegistry() {
  return new PipelineRegistry();
}
