import { NextRequest, NextResponse } from 'next/server';
import { Sandbox } from '@e2b/code-interpreter';

declare global {
  var activeSandbox: any;
  var sandboxData: any;
}

export async function POST(request: NextRequest) {
  try {
    const { packages, sandboxId } = await request.json();
    
    if (!packages || !Array.isArray(packages) || packages.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Packages array is required'
      }, { status: 400 });
    }
    
    // Validate and deduplicate package names
    const validPackages = [...new Set(packages)]
      .filter(pkg => pkg && typeof pkg === 'string' && pkg.trim() !== '')
      .map(pkg => pkg.trim());
    
    if (validPackages.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'No valid package names provided'
      }, { status: 400 });
    }
    
    // Log if duplicates were found
    if (packages.length !== validPackages.length) {
      console.log(`[install-packages] Cleaned packages: removed ${packages.length - validPackages.length} invalid/duplicate entries`);
      console.log(`[install-packages] Original:`, packages);
      console.log(`[install-packages] Cleaned:`, validPackages);
    }
    
    // Try to get sandbox - either from global or reconnect
    let sandbox = global.activeSandbox;
    
    if (!sandbox && sandboxId) {
      console.log(`[install-packages] Reconnecting to sandbox ${sandboxId}...`);
      try {
        sandbox = await Sandbox.connect(sandboxId, { apiKey: process.env.E2B_API_KEY });
        global.activeSandbox = sandbox;
        console.log(`[install-packages] Successfully reconnected to sandbox ${sandboxId}`);
      } catch (error) {
        console.error(`[install-packages] Failed to reconnect to sandbox:`, error);
        return NextResponse.json({
          success: false,
          error: `Failed to reconnect to sandbox: ${(error as Error).message}`
        }, { status: 500 });
      }
    }
    
    if (!sandbox) {
      return NextResponse.json({
        success: false,
        error: 'No active sandbox available'
      }, { status: 400 });
    }
    
    console.log('[install-packages] Installing packages:', packages);
    
    // Create a response stream for real-time updates
    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    
    // Function to send progress updates
    const sendProgress = async (data: any) => {
      const message = `data: ${JSON.stringify(data)}

`;
      await writer.write(encoder.encode(message));
    };
    
    // Start installation in background
    (async (sandboxInstance) => {
      try {
        await sendProgress({
          type: 'start',
          message: `Installing ${validPackages.length} package${validPackages.length > 1 ? 's' : ''}...`,
          packages: validPackages
        });
        
        // Kill any existing Vite process first
        await sendProgress({ type: 'status', message: 'Stopping development server...' });
        
        await sandboxInstance.runCode(`
import subprocess
import os
import signal

# Try to kill any existing Vite process
try:
    with open('/tmp/vite-process.pid', 'r') as f:
        pid = int(f.read().strip())
        os.kill(pid, signal.SIGTERM)
        print("Stopped existing Vite process")
except:
    print("No existing Vite process found")
        `);
        
        // Check which packages are already installed
        await sendProgress({
          type: 'status',
          message: 'Checking installed packages...'
        });
        
        const checkResult = await sandboxInstance.runCode(`
import os
import json

os.chdir('/home/user/app')

# Read package.json to check installed packages
try:
    with open('package.json', 'r') as f:
        package_json = json.load(f)
    
    dependencies = package_json.get('dependencies', {})
    dev_dependencies = package_json.get('devDependencies', {})
    all_deps = {**dependencies, **dev_dependencies}
    
    # Check which packages need to be installed
    packages_to_check = ${JSON.stringify(validPackages)}
    already_installed = []
    need_install = []
    
    for pkg in packages_to_check:
        # Handle scoped packages
        if pkg.startswith('@'):
            pkg_name = pkg
        else:
            # Extract package name without version
            pkg_name = pkg.split('@')[0]
        
        if pkg_name in all_deps:
            already_installed.append(pkg_name)
        else:
            need_install.append(pkg)
    
    print(f"Already installed: {already_installed}")
    print(f"Need to install: {need_install}")
    print(f"NEED_INSTALL:{json.dumps(need_install)}")
    
except Exception as e:
    print(f"Error checking packages: {e}")
    print(f"NEED_INSTALL:{json.dumps(packages_to_check)}")
        `);
        
        // Parse packages that need installation
        let packagesToInstall = validPackages;
        
        // Check if checkResult has the expected structure
        if (checkResult && checkResult.results && checkResult.results[0] && checkResult.results[0].text) {
          const outputLines = checkResult.results[0].text.split('\n');
          for (const line of outputLines) {
            if (line.startsWith('NEED_INSTALL:')) {
              try {
                packagesToInstall = JSON.parse(line.substring('NEED_INSTALL:'.length));
              } catch (e) {
                console.error('Failed to parse packages to install:', e);
              }
            }
          }
        } else {
          console.error('[install-packages] Invalid checkResult structure:', checkResult);
          // If we can't check, just try to install all packages
          packagesToInstall = validPackages;
        }
        
        
        if (packagesToInstall.length === 0) {
          await sendProgress({
            type: 'success',
            message: 'All packages are already installed',
            installedPackages: [],
            alreadyInstalled: validPackages
          });
          return;
        }
        
        // Install only packages that aren't already installed
        const packageList = packagesToInstall.join(' ');
        // Only send the pnpm install command message if we're actually installing new packages
        await sendProgress({
          type: 'info',
          message: `Installing ${packagesToInstall.length} new package(s): ${packagesToInstall.join(', ')}`
        });
        
        const installResult = await sandboxInstance.runCode(`
import subprocess
import os
import json
import time

os.chdir('/home/user/app')

packages_to_install = ${JSON.stringify(packagesToInstall)}
# Initial command: pnpm install <packages>
# Note: pnpm install <packages> will update package.json and pnpm-lock.yaml by default.
# The ERR_PNPM_OUTDATED_LOCKFILE usually occurs with a bare 'pnpm install' or 'pnpm install --frozen-lockfile'.
# However, to be robust, we'll implement a retry.
initial_cmd_args = ['pnpm', 'install'] + packages_to_install

# Store all output for later parsing
all_stdout_lines = []
all_stderr_lines = []
final_rc = 1 # Assume failure initially

def run_pnpm_command(cmd_args, timeout=120):
    """Helper function to run pnpm commands and capture output."""
    print(f"STATUS: Running command: {' '.join(cmd_args)}")
    process = subprocess.Popen(
        cmd_args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    
    current_stdout_lines = []
    current_stderr_lines = []

    # Stream stdout
    while True:
        output = process.stdout.readline()
        if output == '' and process.poll() is not None:
            break
        if output:
            current_stdout_lines.append(output.strip())
            print(output.strip()) # Print to sandbox stdout for real-time logging

    # Capture remaining stderr
    stderr_output = process.stderr.read()
    if stderr_output:
        current_stderr_lines.append(stderr_output.strip())
        print("STDERR:", stderr_output.strip()) # Print to sandbox stdout for real-time logging

    rc = process.poll()
    full_output = "\n".join(current_stdout_lines + current_stderr_lines)
    return rc, full_output, current_stdout_lines, current_stderr_lines

# --- First attempt to install packages ---
print(f"STATUS: Attempt 1: Installing packages: {' '.join(packages_to_install)}")
rc, full_output, stdout_lines, stderr_lines = run_pnpm_command(initial_cmd_args, timeout=120) # Increased timeout

all_stdout_lines.extend(stdout_lines)
all_stderr_lines.extend(stderr_lines)
final_rc = rc

PNPM_OUTDATED_LOCKFILE_ERROR = "ERR_PNPM_OUTDATED_LOCKFILE"
retry_needed = False

if rc != 0 and PNPM_OUTDATED_LOCKFILE_ERROR in full_output:
    print(f"WARNING: Detected '{PNPM_OUTDATED_LOCKFILE_ERROR}'. Attempting to update lockfile and retry.")
    retry_needed = True

if retry_needed:
    # --- Run 'pnpm install --no-frozen-lockfile' to update the lockfile ---
    print("STATUS: Attempting to update lockfile with 'pnpm install --no-frozen-lockfile'...")
    update_rc, update_full_output, update_stdout, update_stderr = run_pnpm_command(['pnpm', 'install', '--no-frozen-lockfile'], timeout=180) # More time for bare install

    all_stdout_lines.extend(update_stdout)
    all_stderr_lines.extend(update_stderr)

    if update_rc != 0:
        print("ERROR: Failed to update lockfile. The original package installation error might persist.")
        # Keep the original rc and output as the primary failure reason
    else:
        print("STATUS: Lockfile updated successfully. Attempt 2: Retrying package installation.")
        # --- Second attempt to install packages ---
        rc, full_output, stdout_lines, stderr_lines = run_pnpm_command(initial_cmd_args, timeout=120)
        
        all_stdout_lines.extend(stdout_lines)
        all_stderr_lines.extend(stderr_lines)
        final_rc = rc # Update final_rc with the result of the second attempt

# --- Final output processing ---
# Check for pnpm specific errors like peer dependency issues
if 'ERR_PNPM_PEER_DEPENDENCY_ISSUES' in "\n".join(all_stderr_lines):
    print("PNPM_PEER_DEPENDENCY_ERROR: Peer dependency issues detected. Consider running 'pnpm install --force' if necessary.")
elif 'ERESOLVE' in "\n".join(all_stderr_lines): # Keep ERESOLVE for npm compatibility if it somehow appears
    print("ERESOLVE_ERROR: Dependency conflict detected - consider using --legacy-peer-deps flag")

print(f"\nInstallation completed with code: {final_rc}")

# Verify packages were installed
import json
with open('/home/user/app/package.json', 'r') as f:
    package_json = json.load(f)
    
installed = []
for pkg in ${JSON.stringify(packagesToInstall)}:
    # Check both dependencies and devDependencies
    if pkg in package_json.get('dependencies', {}) or pkg in package_json.get('devDependencies', {}):
        installed.append(pkg)
        print(f"\u00e2\u02dc\u2020 Verified {pkg}")
    else:
        print(f"\u00e2\u02dc\u2039 Package {pkg} not found in dependencies/devDependencies")
        
print(f"\nVerified installed packages: {installed}")
        `, { timeout: 300000 }); // Increased timeout to 5 minutes for potential retries
        
        // Send pnpm output
        const output = installResult?.output || installResult?.logs?.stdout?.join('\n') || '';
        const pnpmOutputLines = output.split('\n').filter((line: string) => line.trim());
        for (const line of pnpmOutputLines) {
          if (line.includes('STDERR:')) {
            const errorMsg = line.replace('STDERR:', '').trim();
            if (errorMsg && errorMsg !== 'undefined') {
              await sendProgress({ type: 'error', message: errorMsg });
            }
          } else if (line.includes('PNPM_PEER_DEPENDENCY_ERROR:')) {
            const msg = line.replace('PNPM_PEER_DEPENDENCY_ERROR:', '').trim();
            await sendProgress({
              type: 'warning',
              message: `Peer dependency issues detected: ${msg}`
            });
          } else if (line.includes('ERESOLVE_ERROR:')) { // Keep for backward compatibility or if npm errors still appear
            const msg = line.replace('ERESOLVE_ERROR:', '').trim();
            await sendProgress({
              type: 'warning',
              message: `Dependency conflict detected: ${msg}`
            });
          } else if (line.includes('pnpm WARN') || line.includes('npm WARN')) { // Check for both pnpm and npm warnings
            await sendProgress({ type: 'warning', message: line });
          } else if (line.includes('WARNING:')) { // New: Handle custom warning messages from Python
            await sendProgress({ type: 'warning', message: line.replace('WARNING:', '').trim() });
          } else if (line.includes('STATUS:')) { // New: Handle custom status messages from Python
            await sendProgress({ type: 'status', message: line.replace('STATUS:', '').trim() });
          } else if (line.includes('ERROR:') && !line.includes('STDERR:')) { // New: Handle custom error messages from Python, ensure not to double-process STDERR
            await sendProgress({ type: 'error', message: line.replace('ERROR:', '').trim() });
          } else if (line.trim() && !line.includes('undefined')) {
            await sendProgress({ type: 'output', message: line });
          }
        }
        
        // Check if installation was successful
        const installedMatch = output.match(/Verified installed packages: \[(.*?)\]/);
        let installedPackages: string[] = [];
        
        if (installedMatch && installedMatch[1]) {
          installedPackages = installedMatch[1]
            .split(',')
            .map((p: string) => p.trim().replace(/'/g, ''))
            .filter((p: string) => p.length > 0);
        }
        
        if (installedPackages.length > 0) {
          await sendProgress({
            type: 'success',
            message: `Successfully installed: ${installedPackages.join(', ')}`,
            installedPackages
          });
        } else {
          await sendProgress({
            type: 'error',
            message: 'Failed to verify package installation'
          });
        }
        
        // Restart Vite dev server
        await sendProgress({ type: 'status', message: 'Restarting development server...' });
        
        await sandboxInstance.runCode(`
import subprocess
import os
import time

os.chdir('/home/user/app')

# Kill any existing Vite processes
subprocess.run(['pkill', '-f', 'vite'], capture_output=True)
time.sleep(1)

# Start Vite dev server
env = os.environ.copy()
env['FORCE_COLOR'] = '0'

process = subprocess.Popen(
    ['npm', 'run', 'dev'],
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=env
)

print(f'\u00e2\u02dc\u2020 Vite dev server restarted with PID: {process.pid}')

# Store process info for later
with open('/tmp/vite-process.pid', 'w') as f:
    f.write(str(process.pid))

# Wait a bit for Vite to start up
time.sleep(3)

# Touch files to trigger Vite reload
subprocess.run(['touch', '/home/user/app/package.json'])
subprocess.run(['touch', '/home/user/app/vite.config.js'])

print("Vite restarted and should now recognize all packages")
        `);
        
        await sendProgress({
          type: 'complete',
          message: 'Package installation complete and dev server restarted!',
          installedPackages
        });
        
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (errorMessage && errorMessage !== 'undefined') {
          await sendProgress({
            type: 'error',
            message: errorMessage
          });
        }
      } finally {
        await writer.close();
      }
    })(sandbox);
    
    // Return the stream
    return new Response(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
    
  } catch (error) {
    console.error('[install-packages] Error:', error);
    return NextResponse.json({
      success: false,
      error: (error as Error).message
    }, { status: 500 });
  }
}