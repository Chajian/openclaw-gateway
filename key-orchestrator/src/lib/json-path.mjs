export function getByPath(value, path, defaultValue = undefined) {
  if (!path) {
    return value;
  }
  const parts = path.split(".");
  let cur = value;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object" || !(part in cur)) {
      return defaultValue;
    }
    cur = cur[part];
  }
  return cur;
}

