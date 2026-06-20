/** `xorgate monitor` — render the live ink dashboard. */
import { render } from "ink";
import { MonitorApp } from "../monitor/MonitorApp.js";

export async function monitorCommand(agentArgs: string[]): Promise<void> {
  // exitOnCtrlC lets Ctrl+C always bail out; quitting never stops the daemon.
  const { waitUntilExit } = render(<MonitorApp agentArgs={agentArgs} />, { exitOnCtrlC: true });
  await waitUntilExit();
}
