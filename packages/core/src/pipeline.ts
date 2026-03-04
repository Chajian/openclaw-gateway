import type { PipelineStep, PipelineRegistry as IPipelineRegistry } from "./types.js";

interface InternalStep {
  name: string;
  description: string;
  run: (ctx: unknown) => unknown;
  after: string[];
  before: string[];
}

export class PipelineRegistry implements IPipelineRegistry {
  private _steps: Map<string, InternalStep>;

  constructor() {
    this._steps = new Map();
  }

  register(name: string, step: PipelineStep): void {
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

  unregister(name: string): void {
    this._steps.delete(name);
  }

  has(name: string): boolean {
    return this._steps.has(name);
  }

  list(): Array<{ name: string; description: string; after: string[]; before: string[] }> {
    return Array.from(this._steps.values()).map((s) => ({
      name: s.name,
      description: s.description,
      after: s.after,
      before: s.before
    }));
  }

  _topoSort(): InternalStep[] {
    const steps = Array.from(this._steps.values());
    const nameSet = new Set(steps.map((s) => s.name));
    const adj = new Map<string, string[]>();
    const inDeg = new Map<string, number>();
    for (const s of steps) {
      adj.set(s.name, []);
      inDeg.set(s.name, 0);
    }
    for (const s of steps) {
      for (const dep of s.after) {
        if (nameSet.has(dep)) {
          adj.get(dep)!.push(s.name);
          inDeg.set(s.name, inDeg.get(s.name)! + 1);
        }
      }
      for (const target of s.before) {
        if (nameSet.has(target)) {
          adj.get(s.name)!.push(target);
          inDeg.set(target, inDeg.get(target)! + 1);
        }
      }
    }
    const queue: string[] = [];
    for (const [name, deg] of inDeg) {
      if (deg === 0) {
        queue.push(name);
      }
    }
    const sorted: string[] = [];
    while (queue.length) {
      queue.sort();
      const current = queue.shift()!;
      sorted.push(current);
      for (const next of adj.get(current) || []) {
        inDeg.set(next, inDeg.get(next)! - 1);
        if (inDeg.get(next) === 0) {
          queue.push(next);
        }
      }
    }
    if (sorted.length !== steps.length) {
      throw new Error("Pipeline has circular dependencies");
    }
    return sorted.map((name) => this._steps.get(name)!);
  }

  async runAll(pipelineCtx: unknown): Promise<Array<{ name: string; status: string; startedAt: string; result?: unknown; error?: string }>> {
    const ordered = this._topoSort();
    const results: Array<{ name: string; status: string; startedAt: string; result?: unknown; error?: string }> = [];
    for (const step of ordered) {
      const startedAt = new Date().toISOString();
      try {
        const result = await step.run(pipelineCtx);
        results.push({ name: step.name, status: "ok", startedAt, result });
      } catch (err) {
        results.push({ name: step.name, status: "failed", startedAt, error: (err as Error).message });
        throw err;
      }
    }
    return results;
  }
}

export function createPipelineRegistry(): PipelineRegistry {
  return new PipelineRegistry();
}
