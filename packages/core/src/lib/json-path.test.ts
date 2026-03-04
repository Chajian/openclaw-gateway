import { describe, it, expect } from "vitest";
import { getByPath } from "./json-path.js";

describe("getByPath", () => {
  const obj = {
    a: {
      b: {
        c: 42
      },
      d: [1, 2, 3]
    },
    top: "hello"
  };

  it("returns nested value by dot path", () => {
    expect(getByPath(obj, "a.b.c")).toBe(42);
  });

  it("returns top-level value", () => {
    expect(getByPath(obj, "top")).toBe("hello");
  });

  it("returns the whole value when path is empty", () => {
    expect(getByPath(obj, "")).toBe(obj);
  });

  it("returns defaultValue when path does not exist", () => {
    expect(getByPath(obj, "a.b.missing", "fallback")).toBe("fallback");
  });

  it("returns undefined by default when path does not exist", () => {
    expect(getByPath(obj, "x.y.z")).toBeUndefined();
  });

  it("handles null intermediate values", () => {
    expect(getByPath({ a: null }, "a.b", "default")).toBe("default");
  });

  it("handles non-object input", () => {
    expect(getByPath("string", "length")).toBeUndefined();
  });

  it("navigates into array by numeric index key", () => {
    expect(getByPath(obj, "a.d.1")).toBe(2);
  });
});
