# Timeout Handling in Multi-Stage Workflow

## The Problem

GitHub Actions has a 6-hour (360-minute) timeout per job. Brave builds can take 8-20+ hours on GitHub's 2-core runners.

## Why exec() doesn't have timeout

The `@actions/exec` module doesn't support timeout parameters:

```typescript
export interface ExecOptions {
  cwd?: string
  env?: {[key: string]: string}
  silent?: boolean
  outStream?: stream.Writable
  errStream?: stream.Writable
  windowsVerbatimArguments?: boolean
  failOnStdErr?: boolean
  ignoreReturnCode?: boolean
  delay?: number
  listeners?: { ... }
}
// No timeout option!
```

## How GitHub Actions Handles It

GitHub Actions enforces the timeout at the **job level**, not the process level:

```yaml
jobs:
  build-1:
    runs-on: windows-2022
    timeout-minutes: 360  # Default: 360 (6 hours)
```

When the job timeout is reached:
1. GitHub sends SIGTERM to all processes
2. Waits 7.5 seconds
3. Sends SIGKILL if processes are still running
4. Job is marked as "cancelled" or "timed out"

## Our Solution: Multi-Stage Approach

Instead of trying to timeout individual commands, we **rely on the job timeout**:

### Strategy

```
Job 1 (6 hours) → Save checkpoint → Job 2 (6 hours) → Save checkpoint → ...
```

Each job:
1. Runs for up to 6 hours (GitHub enforces this)
2. If command completes: Upload final artifact, set `finished: true`
3. If job times out: Command is killed, checkpoint already saved
4. Next job: Resume from last checkpoint

### Implementation

```javascript
// Stage 1: npm run init
const initCode = await exec.exec('npm', ['run', 'init', '--', '--no-history'], {
    cwd: braveDir,
    ignoreReturnCode: true
});

// No timeout parameter - GitHub Actions will kill this after 6 hours
```

**After command completes (success or timeout):**

```javascript
if (buildSuccess) {
    // Command completed successfully
    uploadFinalArtifact();
} else {
    // Command timed out or failed
    // Create checkpoint for next stage
    compressAndUploadCheckpoint();
}
```

## Checkpoint Strategy

We don't need to detect timeout because:

1. **Marker files** track progress:
   ```
   build-stage.txt contains: "init" or "build" or "package"
   ```

2. **GitHub kills the process** when timeout is reached

3. **Next job** downloads checkpoint and resumes:
   ```javascript
   // Read marker file
   const currentStage = await fs.readFile('build-stage.txt');
   
   // Resume from that stage
   if (currentStage === 'init') {
       await runInit();
   } else if (currentStage === 'build') {
       await runBuild();
   }
   ```

## Why This Works Better

### Traditional Approach (doesn't work)
```javascript
// Can't do this - no timeout parameter
await exec.exec('npm', ['run', 'build'], {
    timeout: 5.5 * 60 * 60 * 1000  // ❌ Not supported
});
```

### Our Approach (works)
```javascript
// Let GitHub Actions handle timeout
await exec.exec('npm', ['run', 'build'], {
    cwd: braveDir,
    ignoreReturnCode: true
});
// GitHub will kill after 6 hours
// Next job will resume
```

## Edge Cases

### 1. What if checkpoint creation takes too long?

**Problem**: Job times out during checkpoint creation

**Solution**: Use safety margin
```yaml
# Real timeout: 6 hours
# Command runs: ~5.5 hours max (in practice)
# Checkpoint creation: ~10-20 minutes
# Buffer: ~10-20 minutes
```

In practice:
- npm commands respect SIGTERM and exit cleanly
- Checkpoint creation happens in finally block
- If checkpoint fails, next stage will start from beginning (slower but safe)

### 2. What if job is cancelled manually?

**Problem**: User cancels job, no checkpoint created

**Solution**: 
- Previous checkpoint is still available
- Next run will resume from last successful checkpoint
- May lose some progress but won't corrupt build

### 3. What if npm commands hang?

**Problem**: Command hangs indefinitely

**Solution**:
- GitHub Actions timeout still applies
- After 6 hours, SIGTERM → SIGKILL
- Process is forcefully terminated
- Next stage starts fresh or from last checkpoint

## Monitoring Progress

Each stage logs its progress:

```
Stage 1:
✓ Clone brave-core
✓ npm install
→ npm run init (running...)
  ↓ Downloading Chromium...
  ↓ Applying patches...
[6 hours later: GitHub kills job]

Stage 2:
✓ Download checkpoint
✓ Extract checkpoint
→ npm run init (continuing...)
  ↓ Installing hooks...
✓ npm run init complete!
→ npm run build (starting...)
[6 hours later: GitHub kills job]

Stage 3:
✓ Download checkpoint
→ npm run build (continuing...)
  ↓ Compiling chrome/browser...
[etc...]
```

## Alternative Approaches (Not Used)

### 1. Manual Timeout Wrapper
```javascript
function execWithTimeout(command, args, timeout) {
    return Promise.race([
        exec.exec(command, args),
        new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), timeout)
        )
    ]);
}
```

**Problem**: 
- Doesn't actually kill the process
- Process keeps running after Promise rejects
- Can't clean up child processes

### 2. Child Process with Timeout
```javascript
const child = child_process.spawn('npm', ['run', 'build']);
setTimeout(() => child.kill(), timeout);
```

**Problem**:
- Bypasses @actions/exec logging
- Harder to capture output
- More complex error handling

### 3. Smaller Stages
```javascript
// Break npm run build into smaller steps
await exec.exec('gn', ['gen', 'out/Release']);
await exec.exec('ninja', ['-C', 'out/Release', 'chrome']);
await exec.exec('ninja', ['-C', 'out/Release', 'chromedriver']);
```

**Problem**:
- Brave's npm scripts abstract this complexity
- Would need to replicate build system logic
- Less maintainable

## Conclusion

By **trusting GitHub Actions' job timeout** and using **checkpoints between stages**, we get:

✓ Simple implementation (no timeout logic)
✓ Reliable (GitHub enforces limits)
✓ Resumable (checkpoint after each stage)
✓ Maintainable (follows Brave's build scripts)

The key insight: **We don't need to timeout individual commands; we need to checkpoint between jobs.**



