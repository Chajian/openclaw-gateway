import { describe, it, expect } from "vitest";
import { PipelineRegistry } from "./pipeline.js";

describe("PipelineRegistry", () => {
  it("registers and lists steps", () => {
    const pipeline = new PipelineRegistry();
    pipeline.register("step-a", { description: "First", run: async () => {} });
    pipeline.register("step-b", { description: "Second", run: async () => {} });
    const list = pipeline.list();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.name)).toEqual(["step-a", "step-b"]);
  });

  it("unregisters a step", () => {
    const pipeline = new PipelineRegistry();
    pipeline.register("step-a", { description: "A", run: async () => {} });
    pipeline.unregister("step-a");
    expect(pipeline.has("step-a")).toBe(false);
    expect(pipeline.list()).toHaveLength(0);
  });

  it("throws when registering step without run function", () => {
    const pipeline = new PipelineRegistry();
    expect(() => pipeline.register("bad", {} as never)).toThrow("must have a run() function");
  });

  describe("_topoSort", () => {
    it("sorts steps respecting after dependencies", () => {
      const pipeline = new PipelineRegistry();
      pipeline.register("step-b", { description: "B", run: async () => {}, after: ["step-a"] });
      pipeline.register("step-a", { description: "A", run: async () => {} });
      pipeline.register("step-c", { description: "C", run: async () => {}, after: ["step-b"] });
      const sorted = pipeline._topoSort();
      const names = sorted.map((s) => s.name);
      expect(names).toEqual(["step-a", "step-b", "step-c"]);
    });

    it("sorts steps respecting before dependencies", () => {
      const pipeline = new PipelineRegistry();
      pipeline.register("step-a", { description: "A", run: async () => {}, before: ["step-b"] });
      pipeline.register("step-b", { description: "B", run: async () => {} });
      const sorted = pipeline._topoSort();
      const names = sorted.map((s) => s.name);
      expect(names).toEqual(["step-a", "step-b"]);
    });

    it("throws on circular dependencies", () => {
      const pipeline = new PipelineRegistry();
      pipeline.register("step-a", { description: "A", run: async () => {}, after: ["step-b"] });
      pipeline.register("step-b", { description: "B", run: async () => {}, after: ["step-a"] });
      expect(() => pipeline._topoSort()).toThrow("circular dependencies");
    });

    it("ignores unknown dependencies", () => {
      const pipeline = new PipelineRegistry();
      pipeline.register("step-a", { description: "A", run: async () => {}, after: ["unknown-step"] });
      const sorted = pipeline._topoSort();
      expect(sorted).toHaveLength(1);
      expect(sorted[0].name).toBe("step-a");
    });
  });

  describe("runAll", () => {
    it("executes steps in topological order", async () => {
      const pipeline = new PipelineRegistry();
      const order: string[] = [];
      pipeline.register("step-b", {
        description: "B",
        run: async () => { order.push("b"); return "result-b"; },
        after: ["step-a"]
      });
      pipeline.register("step-a", {
        description: "A",
        run: async () => { order.push("a"); return "result-a"; }
      });
      const results = await pipeline.runAll({});
      expect(order).toEqual(["a", "b"]);
      expect(results).toHaveLength(2);
      expect(results[0].name).toBe("step-a");
      expect(results[0].status).toBe("ok");
      expect(results[1].name).toBe("step-b");
      expect(results[1].result).toBe("result-b");
    });

    it("propagates errors and marks failed step", async () => {
      const pipeline = new PipelineRegistry();
      pipeline.register("fail-step", {
        description: "Fails",
        run: async () => { throw new Error("boom"); }
      });
      await expect(pipeline.runAll({})).rejects.toThrow("boom");
    });
  });
});
