import { Logger } from "tslog";

const isJson = process.env.LOG_FORMAT === "json";

const logger = new Logger({
  name: "openclaw",
  type: isJson ? "json" : "pretty",
  prettyLogTemplate: "{{dateIsoStr}} {{logLevelName}} ",
  prettyLogTimeZone: "UTC",
  minLevel: 0
});

export function info(message: string, extra: string = ""): void {
  logger.info(`${message}${extra ? ` ${extra}` : ""}`);
}

export function warn(message: string, extra: string = ""): void {
  logger.warn(`${message}${extra ? ` ${extra}` : ""}`);
}

export function error(message: string, extra: string = ""): void {
  logger.error(`${message}${extra ? ` ${extra}` : ""}`);
}
