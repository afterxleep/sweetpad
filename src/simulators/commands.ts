import * as vscode from "vscode";
import { askSimulator } from "../build/utils.js";
import type { CommandExecution } from "../common/commands.js";
import { runTask } from "../common/tasks.js";
import type { iOSSimulatorDestinationTreeItem } from "../destination/tree.js";
import { ExtensionError } from "../common/errors.js";
import type { SelectedDestination } from "../destination/types.js";
import type { SimulatorDestination } from "../simulators/types.js";
import { Logger } from "../common/logger.js";
import { spawn } from "child_process";

const simulatorLogger = new Logger({ name: "Simulator" });
let logsProcess: ReturnType<typeof spawn> | null = null;

/**
 * Focus the simulator logs output channel
 * This can be called from anywhere to bring the simulator logs into focus
 */
export function focusSimulatorLogs() {
  simulatorLogger.show();
}

/**
 * Stream simulator logs directly to the output channel without using task system
 */
async function streamLogsToChannel(simulatorUdid: string): Promise<void> {
  // Kill any existing log process
  if (logsProcess) {
    try {
      logsProcess.kill('SIGTERM');
    } catch (error) {
      // Ignore errors when killing the process
    }
    logsProcess = null;
  }
  
  simulatorLogger.show();
  
  // Start a new log streaming process with detached option so it runs independently
  logsProcess = spawn('xcrun', ['simctl', 'spawn', 'booted', 'log', 'stream', '--level=debug'], {
    detached: true, // Run in a separate process group
    stdio: ['ignore', 'pipe', 'pipe'] // Redirect stdio so parent can exit
  });
  
  // Capture logs but don't let this process keep the app from running
  logsProcess.stdout?.on('data', (data) => {
    simulatorLogger.log(data.toString());
  });
  
  logsProcess.stderr?.on('data', (data) => {
    simulatorLogger.error(data.toString());
  });
  
  logsProcess.on('error', (error) => {
    simulatorLogger.error(`Log streaming error: ${error.message}`);
  });
  
  logsProcess.on('close', (code) => {
    if (code !== 0 && code !== null) {
      simulatorLogger.log(`Log streaming process exited with code ${code}`);
    }
    logsProcess = null;
  });
  
  // Unref the process so it doesn't prevent the parent from exiting
  logsProcess.unref();
}

/**
 * Command to start simulator from the simulator tree view in the sidebar
 */
export async function startSimulatorCommand(execution: CommandExecution, item?: iOSSimulatorDestinationTreeItem) {
  let simulatorUdid: string;
  if (item) {
    simulatorUdid = item.simulator.udid;
  } else {
    const simulator = await askSimulator(execution.context, {
      title: "Select simulator to start",
      state: "Shutdown",
      error: "No available simulators to start",
    });
    simulatorUdid = simulator.udid;
  }

  await runTask(execution.context, {
    name: "Start Simulator",
    lock: "sweetpad.simulators",
    terminateLocked: true,
    callback: async (terminal) => {
      await terminal.execute({
        command: "xcrun",
        args: ["simctl", "boot", simulatorUdid],
      });

      await execution.context.destinationsManager.refreshSimulators();
    },
  });
}

/**
 * Command to stop simulator from the simulator tree view in the sidebar
 */
export async function stopSimulatorCommand(execution: CommandExecution, item?: iOSSimulatorDestinationTreeItem) {
  let simulatorId: string;
  if (item) {
    simulatorId = item.simulator.udid;
  } else {
    const simulator = await askSimulator(execution.context, {
      title: "Select simulator to stop",
      state: "Booted",
      error: "No available simulators to stop",
    });
    simulatorId = simulator.udid;
  }

  await runTask(execution.context, {
    name: "Stop Simulator",
    lock: "sweetpad.simulators",
    terminateLocked: true,
    callback: async (terminal) => {
      await terminal.execute({
        command: "xcrun",
        args: ["simctl", "shutdown", simulatorId],
      });

      await execution.context.destinationsManager.refreshSimulators();
    },
  });
}

/**
 * Command to delete simulator from top of the simulator tree view in the sidebar
 */
export async function openSimulatorCommand(execution: CommandExecution) {
  await runTask(execution.context, {
    name: "Open Simulator",
    error: "Could not open simulator app",
    lock: "sweetpad.simulators",
    terminateLocked: true,
    callback: async (terminal) => {
      await terminal.execute({
        command: "open",
        args: ["-a", "Simulator"],
      });

      vscode.commands.executeCommand("sweetpad.simulators.refresh");
    },
  });
}

/**
 * Command to delete simulators cache from top of the simulator tree view in the sidebar.
 * This is useful when you have a lot of simulators and you want to free up some space.
 * Also in some cases it can help to issues with starting simulators.
 */
export async function removeSimulatorCacheCommand(execution: CommandExecution) {
  await runTask(execution.context, {
    name: "Remove Simulator Cache",
    error: "Error removing simulator cache",
    lock: "sweetpad.build",
    terminateLocked: true,
    callback: async (terminal) => {
      await terminal.execute({
        command: "rm",
        args: ["-rf", "~/Library/Developer/CoreSimulator/Caches"],
      });
      vscode.commands.executeCommand("sweetpad.simulators.refresh");
    },
  });
}

/**
 * Command to stream simulator logs to a dedicated output channel
 * This can be used from the command palette or programmatically
 */
export async function streamSimulatorLogsCommand(execution: CommandExecution, item?: iOSSimulatorDestinationTreeItem) {
  let simulatorUdid: string;
  if (item) {
    simulatorUdid = item.simulator.udid;
  } else {
    const selectedDestination = execution.context.destinationsManager.getSelectedXcodeDestinationForBuild();
    if (!selectedDestination) {
      throw new ExtensionError("No destination selected. Please select a simulator first.");
    }

    const destinations = await execution.context.destinationsManager.getDestinations({
      mostUsedSort: true,
    });

    const destination = destinations.find(
      (d) => d.id === selectedDestination.id && d.type === selectedDestination.type
    );

    if (!destination || !destination.type.includes("Simulator")) {
      throw new ExtensionError("No simulator selected. Please select a simulator first.");
    }

    simulatorUdid = (destination as SimulatorDestination).udid;
  }

  // Stream logs directly instead of using the task system
  await streamLogsToChannel(simulatorUdid);
}
