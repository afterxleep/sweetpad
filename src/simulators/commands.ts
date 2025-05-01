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
import { exec } from "../common/exec.js";

const simulatorLogger = new Logger({ name: "Simulator" });
let logsProcess: ReturnType<typeof spawn> | null = null;
let outputChannel: vscode.OutputChannel | null = null;

/**
 * Write log directly to output channel without the Logger formatting
 * This bypasses the built-in formatting to provide cleaner output
 */
function writeToOutputChannel(text: string) {
  if (!outputChannel) {
    // Get the private outputChannel from the logger
    // @ts-ignore - accessing private property
    outputChannel = simulatorLogger.outputChannel;
  }
  
  if (outputChannel) {
    outputChannel.appendLine(text);
  } else {
    // Fallback to regular logger if we can't get the channel
    simulatorLogger.log(text);
  }
}

/**
 * Focus the simulator logs output channel
 * This can be called from anywhere to bring the simulator logs into focus
 */
export function focusSimulatorLogs() {
  simulatorLogger.show();
}

/**
 * Stream simulator logs directly to the output channel without using task system
 * @param simulatorUdid The UDID of the simulator
 * @param appName The app name to filter logs by
 */
async function streamLogsToChannel(simulatorUdid: string, appName: string): Promise<void> {
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
  
  // Extract the base app name without extension
  const baseAppName = appName.replace(/\.app$/, '');
  const debugDylibPattern = `${baseAppName}.debug.dylib`;
  
  // Clear any existing content and show initial messages
  if (!outputChannel) {
    // @ts-ignore - accessing private property
    outputChannel = simulatorLogger.outputChannel;
  }
  
  if (outputChannel) {
    outputChannel.clear();
    outputChannel.appendLine(`🔎 Filtering logs for: ${debugDylibPattern}`);
    outputChannel.appendLine(`⏱️ Started: ${new Date().toLocaleTimeString()}`);
    outputChannel.appendLine('───────────────────────────────────');
  } else {
    simulatorLogger.log(`Filtering logs for: ${debugDylibPattern}`);
    simulatorLogger.log(`Log stream started - filtering for: ${debugDylibPattern}`);
  }
  
  // Create the log command with no predicate - we'll filter in memory
  const logArgs = [
    'simctl', 
    'spawn', 
    'booted', 
    'log', 
    'stream', 
    '--style', 
    'syslog', 
    '--color', 
    'always', 
    '--level', 
    'debug'
  ];
  
  // Start the log process
  logsProcess = spawn('xcrun', logArgs, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  // Create a better filter regex that looks for library patterns in log output
  // This makes it more precise and avoids capturing unrelated logs
  const logPattern = new RegExp(`(?:loaded|from|by) .*?${baseAppName}\\.debug\\.dylib`, 'i');
  
  // Regex to extract just the message content after all the metadata
  // This matches the standard iOS log output format and extracts just the message part
  const messageExtractor = /.*?\(.*?\.debug\.dylib\)\s+\[(.*?)\]\s+(.*)/;
  
  // Map log levels to emoji icons
  const logLevelToEmoji: Record<string, string> = {
    default: '📝',
    info: 'ℹ️',
    debug: '🪲',
    error: '❌',
    fault: '💥',
    warning: '⚠️'
  };
  
  // Capture logs, filter them, and log only matching lines
  logsProcess.stdout?.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      // Only output lines that likely contain useful information about our app
      if (logPattern.test(line) || 
          (line.toLowerCase().includes(debugDylibPattern.toLowerCase()) && 
           !line.includes('getpwuid_r did not find a match'))) {
        
        // Extract and format the relevant parts of the log message
        const match = line.match(messageExtractor);
        if (match && match.length >= 3) {
          // Get the subsystem:category parts and extract just the category
          const subsystemCategory = match[1];
          const category = subsystemCategory.split(':').pop() || 'Log';
          const message = match[2];
          
          // Detect log level from the line text or category
          let logLevel = 'default';
          if (line.toLowerCase().includes(' error') || subsystemCategory.toLowerCase().includes('error')) {
            logLevel = 'error';
          } else if (line.toLowerCase().includes(' warn') || subsystemCategory.toLowerCase().includes('warn')) {
            logLevel = 'warning';
          } else if (line.toLowerCase().includes(' info') || subsystemCategory.toLowerCase().includes('info')) {
            logLevel = 'info';
          } else if (line.toLowerCase().includes(' debug') || subsystemCategory.toLowerCase().includes('debug')) {
            logLevel = 'debug';
          } else if (line.toLowerCase().includes(' fault') || subsystemCategory.toLowerCase().includes('fault')) {
            logLevel = 'fault';
          }
          
          const emoji = logLevelToEmoji[logLevel] || logLevelToEmoji.default;
          
          // Write directly to the output channel without timestamp and level
          if (outputChannel) {
            outputChannel.appendLine(`${emoji}  [${category}]`);
            outputChannel.appendLine(`${message}`);
            outputChannel.appendLine('───────────────');
          } else {
            simulatorLogger.log(`${emoji}  [${category}]`);
            simulatorLogger.log(`${message}`);
            simulatorLogger.log('───────────────');
          }
        } else {
          if (outputChannel) {
            outputChannel.appendLine(line);
          } else {
            simulatorLogger.log(line);
          }
        }
      }
    }
  });
  
  logsProcess.stderr?.on('data', (data) => {
    if (outputChannel) {
      outputChannel.appendLine(`❌ Error: ${data.toString()}`);
    } else {
      simulatorLogger.error(data.toString());
    }
  });
  
  logsProcess.on('error', (error) => {
    if (outputChannel) {
      outputChannel.appendLine(`❌ Log streaming error: ${error.message}`);
    } else {
      simulatorLogger.error(`Log streaming error: ${error.message}`);
    }
  });
  
  logsProcess.on('close', (code) => {
    if (code !== 0 && code !== null) {
      if (outputChannel) {
        outputChannel.appendLine(`⚠️ Log streaming process exited with code ${code}`);
      } else {
        simulatorLogger.log(`Log streaming process exited with code ${code}`);
      }
    }
    logsProcess = null;
  });
  
  // Unref the process so it doesn't prevent the parent from exiting
  logsProcess.unref();
}

/**
 * Extracts the app name from path
 * @param appPath Path to the .app bundle
 * @returns App name including .app extension
 */
function extractAppName(appPath: string): string {
  const appNameMatch = appPath.match(/\/([^\/]+\.app)\/?$/);
  if (appNameMatch && appNameMatch[1]) {
    return appNameMatch[1];
  }
  // If we can't extract the name with regex, get the last part of the path
  const parts = appPath.split('/');
  const lastPart = parts[parts.length - 1];
  return lastPart.endsWith('.app') ? lastPart : `${lastPart}.app`;
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
 * Command to stream logs for the launched app in the simulator
 * This can be used from the command palette or programmatically
 */
export async function streamSimulatorLogsCommand(execution: CommandExecution, item?: iOSSimulatorDestinationTreeItem) {
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

  let simulatorUdid = "";
  if (item) {
    simulatorUdid = item.simulator.udid;
  } else {
    simulatorUdid = (destination as SimulatorDestination).udid;
  }

  // Get the last launched app context
  const launchContext = execution.context.getWorkspaceState("build.lastLaunchedApp");
  if (!launchContext) {
    throw new ExtensionError("No app has been launched yet. Please launch an app first.");
  }
  
  // Get the app path
  const appPath = launchContext.appPath;
  if (!appPath) {
    throw new ExtensionError("Could not determine app path from the launched app.");
  }
  
  try {
    // Extract the app name from the path, which we'll use for filtering
    const appName = extractAppName(appPath);
    simulatorLogger.log(`Filtering logs for app: ${appName}`);
    
    // Stream logs for this specific app
    await streamLogsToChannel(simulatorUdid, appName);
  } catch (error) {
    throw new ExtensionError(`Failed to start log streaming: ${error instanceof Error ? error.message : String(error)}`);
  }
}
