import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs, requireArg } from "./lib/args.js";
import { createStore } from "./lib/store.js";
import { error, info } from "./lib/log.js";

async function readFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const storePath = path.resolve(cwd, (args.store as string) || "data/secrets.enc.json");
  const masterEnv = (args["master-key-env"] as string) || "KEYHUB_MASTER_KEY";
  const masterKey = process.env[masterEnv];
  if (!masterKey) {
    throw new Error(`Missing env ${masterEnv}`);
  }

  const name = requireArg(args, "name", "Missing --name <secret-name>");
  let value = args.value as string | undefined;
  if (!value && args.stdin) {
    value = await readFromStdin();
  }
  if (!value && args["value-file"]) {
    const valueFile = path.resolve(cwd, args["value-file"] as string);
    value = (await fs.readFile(valueFile, "utf8")).trim();
  }
  if (!value) {
    throw new Error("Provide secret value with --value, --stdin, or --value-file");
  }

  const store = await createStore(storePath, masterKey);
  store.setSecret(name, value);
  await store.save();
  info("secret stored", name);
}

main().catch((err) => {
  error("import aborted", (err as Error).message);
  process.exitCode = 1;
});
