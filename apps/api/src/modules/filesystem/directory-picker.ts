import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * The operating system's own "choose a folder" dialog.
 *
 * The browser cannot give us one. `showDirectoryPicker()` returns a handle
 * rather than a path, is not implemented everywhere, and would put the walk in
 * the tab — which is exactly the arrangement this codebase avoids: the
 * filesystem belongs to the local runtime, and the local runtime here is the
 * API process.
 *
 * So the API asks the OS. Each platform's dialog is a separate binary with a
 * separate argument list:
 *
 *   macOS    osascript, driving AppleScript's `choose folder`
 *   Windows  powershell, driving System.Windows.Forms.FolderBrowserDialog
 *   Linux    zenity or kdialog, whichever the desktop has
 *
 * Three rules hold for all of them:
 *
 * - **`execFile`, never a shell.** Arguments are passed as an array, so there
 *   is no command line for anything to be interpolated into. Nothing derived
 *   from a request reaches these calls at all — the argument lists are
 *   constants — but the shape is what makes that verifiable rather than
 *   believed.
 * - **Cancelling is a normal outcome**, not an error. Every dialog reports it
 *   as a non-zero exit with no output; all of them come back here as `null`.
 * - **A dialog nobody answers times out.** An unanswered dialog would otherwise
 *   hold a request, a process handle and a window open indefinitely.
 *
 * Where there is no dialog — a headless machine, a container, an SSH session —
 * `isAvailable()` is false and the UI falls back to the browser served by
 * `GET /api/filesystem/directories`, which needs no local windowing system.
 */

export class DirectoryPickerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectoryPickerUnavailableError';
  }
}

export interface DirectoryPicker {
  /** True when this host can actually show a dialog. */
  isAvailable(): boolean;
  /** The chosen absolute path, or null when the user cancelled. */
  pick(options: { timeoutMs: number }): Promise<string | null>;
}

interface PickerCommand {
  command: string;
  args: string[];
}

const APPLESCRIPT = `
try
  set chosen to choose folder with prompt "Select a project folder to index"
  return POSIX path of chosen
on error number -128
  return ""
end try
`;

const POWERSHELL = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select a project folder to index'
$dialog.ShowNewFolderButton = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
`;

export class NativeDirectoryPicker implements DirectoryPicker {
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  isAvailable(): boolean {
    return this.command() !== null;
  }

  async pick(options: { timeoutMs: number }): Promise<string | null> {
    const chosen = this.command();
    if (!chosen) {
      throw new DirectoryPickerUnavailableError(
        `no native folder dialog is available on ${this.platform}`,
      );
    }

    const output = await run(chosen, options.timeoutMs);
    if (output === null) return null;

    const trimmed = output.trim();
    if (trimmed.length === 0) return null;

    // AppleScript's POSIX path carries a trailing separator; nothing else
    // should ever see the difference.
    return path.resolve(trimmed);
  }

  private command(): PickerCommand | null {
    if (this.platform === 'darwin') {
      return { command: 'osascript', args: ['-e', APPLESCRIPT] };
    }

    if (this.platform === 'win32') {
      return {
        command: 'powershell.exe',
        // -STA is required: the folder dialog is a single-threaded COM control.
        args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', POWERSHELL],
      };
    }

    // A Linux desktop has one of these; a server has neither, and no display
    // to show them on even if it did.
    if (!this.env.DISPLAY && !this.env.WAYLAND_DISPLAY) return null;

    return {
      command: 'zenity',
      args: [
        '--file-selection',
        '--directory',
        '--title=Select a project folder to index',
        `--filename=${os.homedir()}/`,
      ],
    };
  }
}

/**
 * Runs the dialog. Returns its output, or null when the user cancelled or the
 * dialog could not be shown at all.
 */
function run(chosen: PickerCommand, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(
      chosen.command,
      chosen.args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 64 },
      (error, stdout) => {
        if (!error) {
          resolve(stdout);
          return;
        }

        // The binary is not installed: that is unavailability, not a failure of
        // this particular attempt, and the caller offers the browser instead.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new DirectoryPickerUnavailableError(
              `${chosen.command} is not installed on this machine`,
            ),
          );
          return;
        }

        if ((error as { killed?: boolean }).killed) {
          reject(new Error('the folder dialog was not answered in time'));
          return;
        }

        // Every dialog reports cancellation as a non-zero exit. There is
        // nothing to distinguish it from a dialog that failed for its own
        // reasons, and treating "I changed my mind" as an error would be the
        // worse mistake of the two.
        resolve(null);
      },
    );
  });
}
