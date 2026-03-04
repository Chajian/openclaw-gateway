import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext, PluginHandle } from "@openclaw/core";
import { info, warn } from "@openclaw/core";

const execFileAsync = promisify(execFile);

function pluginDir(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

async function runPowershell(scriptName: string, extraArgs: string[] = []): Promise<void> {
  const scriptPath = path.join(pluginDir(), "scripts", scriptName);
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...extraArgs];
  const { stdout, stderr } = await execFileAsync("powershell", args, {
    windowsHide: true,
    timeout: 600_000
  });
  if (stdout) {
    info("ps1", stdout.trim());
  }
  if (stderr && stderr.trim()) {
    warn("ps1 stderr", stderr.trim());
  }
}

export function activate(ctx: PluginContext): PluginHandle {
  const config = ctx.config || {};

  ctx.commands.register("task:install", {
    description: "Install Windows scheduled tasks for daily cycles",
    run: async () => {
      const stableTime = (config.stableCycleTime as string) || "09:10";
      const linuxdoTime = (config.linuxdoCycleTime as string) || "08:40";
      info("task:install", `stable@${stableTime} linuxdo@${linuxdoTime}`);
      await runPowershell("install-daily-task.ps1", ["-RunAt", stableTime]);
      await runPowershell("install-linuxdo-daily-task.ps1", ["-RunAt", linuxdoTime]);
    }
  });

  ctx.schedules.register("stable-daily", {
    description: "Daily stable key sync cycle with Feishu notification",
    run: async () => {
      await runPowershell("run-stable-cycle.ps1");
    }
  });

  ctx.schedules.register("linuxdo-daily", {
    description: "Daily LinuxDo discovery + onboard cycle with Feishu notification",
    run: async () => {
      await runPowershell("run-linuxdo-discovery-cycle.ps1");
    }
  });

  return {
    name: "@openclaw/plugin-schedule-windows",
    deactivate() {
      ctx.commands.unregister("task:install");
      ctx.schedules.unregister("stable-daily");
      ctx.schedules.unregister("linuxdo-daily");
    }
  };
}
