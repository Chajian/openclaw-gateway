const now = () => new Date().toISOString();

export function info(message, extra = "") {
  process.stdout.write(`[${now()}] INFO  ${message}${extra ? ` ${extra}` : ""}\n`);
}

export function warn(message, extra = "") {
  process.stdout.write(`[${now()}] WARN  ${message}${extra ? ` ${extra}` : ""}\n`);
}

export function error(message, extra = "") {
  process.stderr.write(`[${now()}] ERROR ${message}${extra ? ` ${extra}` : ""}\n`);
}

