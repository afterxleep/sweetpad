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

const OSLogger = new Logger({ name: "OSLog" });
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
    outputChannel = OSLogger.outputChannel;
  }
  
  if (outputChannel) {
    outputChannel.appendLine(text);
  } else {
    // Fallback to regular logger if we can't get the channel
    OSLogger.log(text);
  }
}

/**
 * Focus the simulator logs output channel
 * This can be called from anywhere to bring the simulator logs into focus
 */
export function focusSimulatorLogs() {
  OSLogger.show();
}

/**
 * Stream logs directly to the output channel without using task system
 * @param destination The destination (simulator or device)
 * @param appName The app name to filter logs by
 */
async function streamLogsToChannel(destination: { udid: string; type: string }, appName: string): Promise<void> {
  // Kill any existing log process
  if (logsProcess) {
    try {
      logsProcess.kill('SIGTERM');
    } catch (error) {
      // Ignore errors when killing the process
    }
    logsProcess = null;
  }
  
  OSLogger.show();
  
  // Extract the base app name without extension
  const baseAppName = appName.replace(/\.app$/, '');
  const debugDylibPattern = `${baseAppName}.debug.dylib`;
  
  // Clear any existing content and show initial messages
  if (!outputChannel) {
    // @ts-ignore - accessing private property
    outputChannel = OSLogger.outputChannel;
  }
  
  if (outputChannel) {
    outputChannel.clear();
    outputChannel.appendLine(`⏱️ Started: ${new Date().toLocaleTimeString()}`);
    outputChannel.appendLine('───────────────────────────────────');
  } else {
    OSLogger.log(`Log stream started for: ${debugDylibPattern}`);
  }
  
  // Determine if this is a simulator or a physical device
  const isSimulator = destination.type.includes('Simulator');
  
  let logArgs: string[];
  
  if (isSimulator) {
    // Arguments for simulator log streaming
    logArgs = [
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
  } else {
    // Arguments for physical device log streaming
    logArgs = [
      'devicectl',
      'device',
      'syslog',
      '--device',
      destination.udid,
      '--color',
      'always',
      '--level',
      'debug'
    ];
  }
  
  // Start the log process with the appropriate command
  logsProcess = spawn('xcrun', logArgs, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  // Patterns to identify system logs we want to ignore
  const appleSystemPatterns = [
    /\[com\.apple\.Previews\.StubExecutor:PreviewsAgentExecutorLibrary\]/i,
    /Found debug dylib/i,
    /Opening debug dylib/i
  ];
  
  // Pattern to match app logs with the format:
  // (AppName.debug.dylib) [bundle.identifier:Category] Message
  const appLogPattern = new RegExp(`\\(${baseAppName}\\.debug\\.dylib\\)\\s+\\[(.*?)\\]\\s+(.*)`, 'i');
  
  // Alternative pattern for device logs which might have a different format
  const deviceLogPattern = new RegExp(`${baseAppName}\\[\\d+\\].*?\\[(.*?)\\]\\s+(.*)`, 'i');
  
  // Map log levels to emoji icons
  const logLevelToEmoji: Record<string, string> = {
    default: '📝',
    info: 'ℹ️',
    debug: '🪲',
    error: '❌',
    fault: '💥',
    warning: '⚠️'
  };
  
  // Words that indicate specific log levels in the message content
  const errorKeywords = ['fail', 'error', 'exception', 'crash', 'invalid', 'unable', 'not found'];
  const warningKeywords = ['warn', 'deprecat', 'unresponsive', 'elevated', 'excessive', 'timeout', 'slow'];
  const debugKeywords = ['debug', 'trace', 'verbose'];
  
  // Capture logs, filter them, and log only matching lines
  logsProcess.stdout?.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      // Skip empty lines
      if (!line.trim()) continue;
      
      // Skip Apple system logs
      if (appleSystemPatterns.some(pattern => pattern.test(line))) {
        continue;
      }
      
      // Try matching with app log pattern first
      let match = line.match(appLogPattern);
      let matched = false;
      
      // If not matched and this is a device, try the device log pattern
      if (!match && !isSimulator) {
        match = line.match(deviceLogPattern);
      }
      
      // Process if we have a match
      if (match && match.length >= 3) {
        matched = true;
        const subsystemCategory = match[1];
        const message = match[2];
        
        // Extract just the category part (after the colon)
        const category = subsystemCategory.split(':').pop() || 'Log';
        
        // Check message content to better detect log level
        const lowerMessage = message.toLowerCase();
        
        // Start with default log level
        let logLevel = 'info'; // Default to info 
        
        // Check for error keywords
        if (errorKeywords.some(keyword => lowerMessage.includes(keyword))) {
          logLevel = 'error';
        } 
        // Check for warning keywords
        else if (warningKeywords.some(keyword => lowerMessage.includes(keyword))) {
          logLevel = 'warning';
        }
        // Check for debug keywords
        else if (debugKeywords.some(keyword => lowerMessage.includes(keyword))) {
          logLevel = 'debug';
        }
        
        // Override based on category if it contains specific level indicators
        const lowerCategory = category.toLowerCase();
        if (lowerCategory.includes('error')) {
          logLevel = 'error';
        } else if (lowerCategory.includes('warn')) {
          logLevel = 'warning';
        } else if (lowerCategory.includes('debug')) {
          logLevel = 'debug';
        }
        
        const emoji = logLevelToEmoji[logLevel] || logLevelToEmoji.default;
        
        // Write directly to the output channel without timestamp and level
        if (outputChannel) {
          outputChannel.appendLine(`${emoji}  [${category}]`);
          outputChannel.appendLine(`${message}`);
          outputChannel.appendLine('───────────────');
        } else {
          OSLogger.log(`${emoji}  [${category}]`);
          OSLogger.log(`${message}`);
          OSLogger.log('───────────────');
        }
      } 
      // For device logs, if we still didn't match but the line contains our app name,
      // show it with minimal formatting
      else if (!isSimulator && !matched && line.includes(baseAppName)) {
        if (outputChannel) {
          // Simple cleaning: try to remove timestamp and device prefix
          const cleanedLine = line.replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+[-+]\d{4}\s+\w+\s+/, '');
          outputChannel.appendLine(`📱 ${cleanedLine}`);
          outputChannel.appendLine('───────────────');
        } else {
          OSLogger.log(line);
        }
      }
    }
  });
  
  // List of system messages to ignore
  const ignoredSystemMessages = [
    'getpwuid_r did not find a match',
    'Could not get register values'
  ];
  
  logsProcess.stderr?.on('data', (data) => {
    const errorText = data.toString();
    
    // Check if this is a known harmless system message we should ignore
    const shouldIgnore = ignoredSystemMessages.some(msg => errorText.includes(msg));
    
    if (!shouldIgnore) {
      if (outputChannel) {
        outputChannel.appendLine(`❌ Error: ${errorText}`);
      } else {
        OSLogger.error(errorText);
      }
    }
  });
  
  logsProcess.on('error', (error) => {
    if (outputChannel) {
      outputChannel.appendLine(`❌ Log streaming error: ${error.message}`);
    } else {
      OSLogger.error(`Log streaming error: ${error.message}`);
    }
  });
  
  logsProcess.on('close', (code) => {
    if (code !== 0 && code !== null) {
      if (outputChannel) {
        outputChannel.appendLine(`⚠️ Log streaming process exited with code ${code}`);
      } else {
        OSLogger.log(`Log streaming process exited with code ${code}`);
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
 * Command to stream logs for the launched app in the simulator or device
 * This can be used from the command palette or programmatically
 */
export async function streamLogsCommand(execution: CommandExecution, item?: iOSSimulatorDestinationTreeItem) {
  const selectedDestination = execution.context.destinationsManager.getSelectedXcodeDestinationForBuild();
  if (!selectedDestination) {
    throw new ExtensionError("No destination selected. Please select a simulator or device first.");
  }

  const destinations = await execution.context.destinationsManager.getDestinations({
    mostUsedSort: true,
  });

  const destination = destinations.find(
    (d) => d.id === selectedDestination.id && d.type === selectedDestination.type
  );

  if (!destination) {
    throw new ExtensionError("No destination selected. Please select a simulator or device first.");
  }

  let destinationInfo = {
    udid: "",
    type: destination.type
  };
  
  if (item) {
    destinationInfo.udid = item.simulator.udid;
  } else if (destination.type.includes("Simulator")) {
    destinationInfo.udid = (destination as SimulatorDestination).udid;
  } else {
    // For physical devices
    destinationInfo.udid = destination.id;
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
    
    // Stream logs for this specific app
    await streamLogsToChannel(destinationInfo, appName);
  } catch (error) {
    throw new ExtensionError(`Failed to start log streaming: ${error instanceof Error ? error.message : String(error)}`);
  }
}
