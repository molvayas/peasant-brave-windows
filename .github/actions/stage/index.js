const core = require('@actions/core');
const io = require('@actions/io');
const exec = require('@actions/exec');
const {DefaultArtifactClient} = require('@actions/artifact');
const glob = require('@actions/glob');
const fs = require('fs').promises;
const path = require('path');
const child_process = require('child_process');

/**
 * Run a command with timeout (like ungoogled-chromium's _run_build_process_timeout)
 * @param {string} command - Command to run
 * @param {string[]} args - Command arguments
 * @param {object} options - Options including cwd and timeout in milliseconds
 * @returns {Promise<number>} Exit code (999 if timeout)
 */
async function execWithTimeout(command, args, options = {}) {
    const {cwd, timeout} = options;
    
    return new Promise((resolve) => {
        console.log(`Running: ${command} ${args.join(' ')}`);
        console.log(`Timeout: ${(timeout / 3600000).toFixed(1)} hours`);
        
        const child = child_process.spawn(command, args, {
            cwd: cwd,
            stdio: 'inherit',
            shell: true
        });
        
        let killed = false;
        const timer = setTimeout(() => {
            console.log(`\n⏱️ Timeout reached after ${(timeout / 3600000).toFixed(1)} hours`);
            console.log('Gracefully stopping build process...');
            killed = true;
            
            // Try graceful shutdown first (SIGTERM)
            try {
                process.kill(-child.pid, 'SIGTERM');
            } catch (e) {
                console.log('SIGTERM failed, trying SIGKILL');
                try {
                    process.kill(-child.pid, 'SIGKILL');
                } catch (e2) {
                    console.log('Process already exited');
                }
            }
            
            // Force kill after 30 seconds if still running
            setTimeout(() => {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                } catch (e) {
                    // Already dead
                }
            }, 30000);
        }, timeout);
        
        child.on('exit', (code) => {
            clearTimeout(timer);
            if (killed) {
                console.log('Build process stopped due to timeout');
                resolve(999); // Special code for timeout
            } else {
                console.log(`Process exited with code: ${code}`);
                resolve(code || 0);
            }
        });
        
        child.on('error', (err) => {
            clearTimeout(timer);
            console.error(`Process error: ${err.message}`);
            resolve(1);
        });
    });
}

async function run() {
    process.on('SIGINT', function() {
    });
    
    const finished = core.getBooleanInput('finished', {required: true});
    const from_artifact = core.getBooleanInput('from_artifact', {required: true});
    
    // Read Brave version from brave_version.txt in the repository
    const versionFile = path.join('C:\\peasant-brave-windows', 'brave_version.txt');
    let brave_version = '';
    try {
        brave_version = (await fs.readFile(versionFile, 'utf-8')).trim();
        console.log(`Building Brave version: ${brave_version} (from brave_version.txt)`);
    } catch (e) {
        core.setFailed(`Failed to read brave_version.txt: ${e.message}`);
        return;
    }
    
    console.log(`finished: ${finished}, from_artifact: ${from_artifact}`);
    
    if (finished) {
        core.setOutput('finished', true);
        return;
    }

    const artifact = new DefaultArtifactClient();
    const artifactName = 'build-artifact';
    const workDir = 'C:\\brave-build';
    const srcDir = path.join(workDir, 'src');
    const braveDir = path.join(srcDir, 'brave');

    try {
        await io.mkdirP(srcDir);
    } catch (e) {
        console.log('Work directory already exists');
    }

    if (from_artifact) {
        console.log('Downloading previous build artifact...');
        try {
            const artifactInfo = await artifact.getArtifact(artifactName);
            await artifact.downloadArtifact(artifactInfo.artifact.id, {path: path.join(workDir, 'artifact')});
            await exec.exec('7z', ['x', path.join(workDir, 'artifact', 'build-state.zip'),
                `-o${workDir}`, '-y']);
            await io.rmRF(path.join(workDir, 'artifact'));
        } catch (e) {
            console.error(`Failed to download artifact: ${e}`);
            throw e;
        }
    } else {
        // First stage: clone brave-core and initialize following official structure
        console.log('Initializing Brave build environment...');
        
        // Set environment variables for Brave build
        core.exportVariable('DEPOT_TOOLS_WIN_TOOLCHAIN', '0');
        core.exportVariable('PYTHONUNBUFFERED', '1');
        core.exportVariable('GSUTIL_ENABLE_LUCI_AUTH', '0');
        
        // Install depot_tools dependencies
        await exec.exec('python', ['-m', 'pip', 'install', 'httplib2==0.22.0'], {
            ignoreReturnCode: true
        });

        // Clone brave-core to src/brave (following official structure)
        // Brave uses tags with 'v' prefix (e.g., v1.85.74)
        const braveTag = brave_version.startsWith('v') ? brave_version : `v${brave_version}`;
        console.log(`Cloning brave-core tag ${braveTag} to ${braveDir}...`);
        await exec.exec('git', ['clone', '--branch', braveTag, '--depth=2',
            'https://github.com/brave/brave-core.git', braveDir], {
            ignoreReturnCode: true
        });

        // Install npm dependencies in brave-core
        console.log('Installing npm dependencies...');
        await exec.exec('npm', ['install'], {
            cwd: braveDir,
            ignoreReturnCode: true
        });
    }

    // Create a marker file to track build progress
    const markerFile = path.join(workDir, 'build-stage.txt');
    let currentStage = 'init';
    
    try {
        const markerContent = await fs.readFile(markerFile, 'utf-8');
        currentStage = markerContent.trim();
        console.log(`Resuming from stage: ${currentStage}`);
    } catch (e) {
        console.log('Starting from init stage');
    }

    let buildSuccess = false;
    const JOB_START_TIME = Date.now();
    const MAX_JOB_TIME = 15 * 60 * 1000; // 4.5 hours total for the job

    try {
        // Stage 1: npm run init (downloads Chromium and dependencies)
        // Note: We don't pass target_os/target_arch on Windows, it auto-detects
        // npm run init runs WITHOUT timeout (exempt)
        if (currentStage === 'init') {
            console.log('=== Stage: npm run init ===');
            console.log('Running npm run init with --no-history (no timeout)...');
            
            const initCode = await exec.exec('npm', ['run', 'init', '--', '--no-history'], {
                cwd: braveDir,
                ignoreReturnCode: true
            });
            
            if (initCode === 0) {
                console.log('✓ npm run init completed successfully');
                await fs.writeFile(markerFile, 'build');
                currentStage = 'build';
            } else {
                console.log(`✗ npm run init failed with code ${initCode}`);
                // Stay in init stage to retry
            }
        }

        // Stage 2: npm run build (compile Brave - component build by default)
        // Timeout = 4.5 hours - time already spent in this job
        if (currentStage === 'build') {
            const elapsedTime = Date.now() - JOB_START_TIME;
            const remainingTime = MAX_JOB_TIME - elapsedTime;
            
            console.log('=== Stage: npm run build ===');
            console.log(`Time elapsed in job: ${(elapsedTime / 3600000).toFixed(2)} hours`);
            console.log(`Remaining time for build: ${(remainingTime / 3600000).toFixed(2)} hours`);
            
            if (remainingTime <= 0) {
                console.log('⏱️ No time remaining in job - creating checkpoint');
            } else {
                console.log('Running npm run build (component build)...');
                
                const buildCode = await execWithTimeout('npm', ['run', 'build'], {
                    cwd: braveDir,
                    timeout: remainingTime
                });
                
                if (buildCode === 0) {
                    console.log('✓ npm run build completed successfully');
                    await fs.writeFile(markerFile, 'package');
                    currentStage = 'package';
                    buildSuccess = true;
                } else if (buildCode === 999) {
                    console.log('⏱️ npm run build timed out - will resume in next stage');
                    // Stay in build stage for next run
                } else {
                    console.log(`✗ npm run build failed with code ${buildCode}`);
                    // Stay in build stage to retry
                }
            }
        }

    } catch (e) {
        console.error(`Build error: ${e.message}`);
    }

    if (buildSuccess && currentStage === 'package') {
        console.log('Build completed successfully, uploading final artifacts...');
        
        // Find built executables and installers
        const globber = await glob.create(path.join(workDir, 'src', 'out', 'Release', '*.exe'), {
            matchDirectories: false
        });
        const installerGlobber = await glob.create(path.join(workDir, 'src', 'out', 'Release', 'BraveBrowser*.exe'), {
            matchDirectories: false
        });
        
        let packageList = await installerGlobber.glob();
        
        if (packageList.length === 0) {
            console.log('No installer found, packaging brave.exe...');
            // Package the browser executable
            const outDir = path.join(workDir, 'src', 'out', 'Release');
            await exec.exec('7z', ['a', '-tzip', 
                path.join(workDir, `brave-browser-${brave_version}-win-x64.zip`),
                path.join(outDir, 'brave.exe'),
                path.join(outDir, '*.dll'),
                path.join(outDir, '*.pak'),
                path.join(outDir, 'locales'),
                '-mx=5'], {ignoreReturnCode: true});
            packageList = [path.join(workDir, `brave-browser-${brave_version}-win-x64.zip`)];
        }

        // Upload final artifact
        for (let i = 0; i < 5; ++i) {
            try {
                await artifact.deleteArtifact('brave-browser');
            } catch (e) {
                // ignored
            }
            try {
                await artifact.uploadArtifact('brave-browser', packageList, workDir, 
                    {retentionDays: 7, compressionLevel: 0});
                console.log('Successfully uploaded final artifact');
                break;
            } catch (e) {
                console.error(`Upload artifact failed: ${e}`);
                await new Promise(r => setTimeout(r, 10000));
            }
        }
        
        core.setOutput('finished', true);
    } else {
        console.log('Build incomplete, creating checkpoint artifact...');
        
        // Save build state
        await new Promise(r => setTimeout(r, 5000));
        
        // Compress critical build directories AND marker file
        // Keep obj/ directory for incremental builds!
        const stateZip = path.join(workDir, 'build-state.zip');
        await exec.exec('7z', ['a', '-tzip', stateZip,
            path.join(workDir, 'src'),
            path.join(workDir, 'build-stage.txt'),
            '-mx=3', '-mtc=on'], 
            {ignoreReturnCode: true});

        // Upload intermediate artifact
        for (let i = 0; i < 5; ++i) {
            try {
                await artifact.deleteArtifact(artifactName);
            } catch (e) {
                // ignored
            }
            try {
                await artifact.uploadArtifact(artifactName, [stateZip], workDir, 
                    {retentionDays: 1, compressionLevel: 0});
                console.log('Successfully uploaded checkpoint artifact');
                break;
            } catch (e) {
                console.error(`Upload artifact failed: ${e}`);
                await new Promise(r => setTimeout(r, 10000));
            }
        }
        
        core.setOutput('finished', false);
    }
}

run().catch(err => core.setFailed(err.message));

