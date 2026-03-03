import { info, warn } from "@openclaw/core";

export function activate(ctx) {
  const config = ctx.config || {};
  const intervalMs = config.intervalMs || 600000;
  const telegramChatId = config.telegramChatId || "";

  ctx.commands.register("monitor:start", {
    description: "Start monitoring LinuxDo welfare posts (placeholder)",
    run: async () => {
      info("monitor:start", "LinuxDo monitor is a placeholder — Docker service migration pending");
      info("monitor:config", `intervalMs=${intervalMs} telegramChatId=${telegramChatId}`);
    }
  });

  ctx.schedules.register("linuxdo-monitor", {
    description: "Periodic LinuxDo welfare post monitoring",
    intervalMs,
    run: async () => {
      warn("linuxdo-monitor", "schedule placeholder — not yet implemented");
    }
  });

  return {
    name: "@openclaw/plugin-linuxdo-monitor",
    deactivate() {
      ctx.commands.unregister("monitor:start");
      ctx.schedules.unregister("linuxdo-monitor");
    }
  };
}
