export function getByPath(value: unknown, path: string, defaultValue: unknown = undefined): unknown {
  if (!path) {
    return value;
  }
  const parts = path.split(".");
  let cur: unknown = value;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object" || !(part in (cur as Record<string, unknown>))) {
      return defaultValue;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
