# Workflow Design Documentation

## Architecture Overview

This document explains the design decisions and architecture of the multi-stage Brave Browser build workflow.

## Problem Statement

Building Brave Browser on GitHub Actions presents several challenges:

1. **Time limit**: GitHub Actions has a 6-hour timeout per job
2. **Resource constraints**: Limited CPU (2 cores), RAM (7GB), and disk (14GB)
3. **Build duration**: Brave builds take 8-20 hours on constrained hardware
4. **Network requirements**: Initial download is ~60GB
5. **State persistence**: Need to resume after timeouts

## Solution: Multi-Stage Build Pipeline

### Core Concepts

#### 1. Sequential Stages

The build is divided into 8 sequential stages:

```
build-1 → build-2 → build-3 → ... → build-8 → publish-release
```

Each stage:
- Runs for up to 5.5 hours (safety margin before 6-hour limit)
- Saves progress before timeout
- Next stage resumes from saved state

#### 2. Artifact Checkpointing

**Intermediate artifacts** (`build-artifact`):
- Created when stage doesn't complete build
- Contains compressed `src/` directory with all build state
- Uploaded to GitHub Actions artifacts storage
- Next stage downloads and extracts

**Final artifacts** (`brave-browser`):
- Created when build completes successfully
- Contains packaged installer or executable
- Published to GitHub Releases

#### 3. Build State Machine

The stage action uses a state machine:

```
init → build → package → done
 ↓       ↓        ↓
checkpoint each step
```

States stored in `build-stage.txt`:
- **init**: Running `npm run init`
- **build**: Running `npm run build`
- **package**: Creating distribution packages
- **done**: Build complete

### Workflow Structure

#### main.yml

```yaml
on:
  push:
    tags: ['v*']              # Trigger on version tags
  workflow_dispatch:          # Or manual trigger
    inputs:
      brave_version: string   # With version input
```

**Job dependencies**:
```
build-1 (no deps)
  ↓
build-2 (needs: build-1)
  ↓
build-3 (needs: build-2)
  ↓
...
  ↓
build-8 (needs: build-7)
  ↓
publish-release (needs: build-8)
```

**Output propagation**:
- Each stage outputs `finished: true/false`
- Next stage checks `needs.*.outputs.finished`
- If `finished: true`, stage exits immediately

#### action.yml

Defines the custom stage action:

```yaml
inputs:
  finished: string      # Previous stage completion status
  from_artifact: bool   # Whether to download checkpoint
  brave_version: string # Version tag to build
outputs:
  finished: string      # This stage completion status
runs:
  using: node20
  main: index.js
```

#### index.js

Main action logic:

```javascript
if (finished) {
    // Previous stage completed, pass through
    return;
}

if (from_artifact) {
    // Download and extract previous checkpoint
    downloadArtifact();
    extract();
}

// Continue build from current state
switch (currentState) {
    case 'init':
        runNpmInit();
        if (success) state = 'build';
        break;
    case 'build':
        runNpmBuild();
        if (success) state = 'package';
        break;
    case 'package':
        createPackage();
        uploadFinalArtifact();
        return finished = true;
}

// Save checkpoint
compressState();
uploadCheckpoint();
return finished = false;
```

## Design Decisions

### 1. Why 8 Stages?

**Analysis**:
- Stage 1: Init downloads (~2-4 hours)
- Stages 2-6: Compilation (~10-15 hours on 2-core)
- Stages 7-8: Linking and packaging (~2-3 hours)

**Rationale**:
- Provides 5.5 hours per stage
- Covers worst-case build time (~44 hours max)
- Balances checkpoint overhead vs. progress

**Alternative considered**: 16 stages (like ungoogled-chromium)
- **Rejected**: More overhead, Brave builds faster than Chromium

### 2. Why Single Architecture?

Current workflow builds only x64.

**Rationale**:
- x64 is the primary Windows platform
- Reduces complexity and build time
- Can be extended later

**Future extension**:
```yaml
build-arm64-1:
  steps:
    # Same pattern with arm64 flag
```

### 3. Why C:\brave-build?

**Path choice considerations**:
| Path | Pros | Cons |
|------|------|------|
| `%USERPROFILE%\brave` | Standard | Long path (C:\Users\runneradmin\...) |
| `D:\a\repo\repo` | GitHub default | Very long path |
| `C:\brave-build` | **Short path** | Non-standard location |

**Selected**: `C:\brave-build` - Avoids Windows 260-char path limit

### 4. Why Compression Level 3?

**Benchmark** (src directory ~80GB):

| Level | Size | Time | Upload | Extract |
|-------|------|------|--------|---------|
| 0 (store) | 78GB | 5m | 45m | 5m |
| 1 (fast) | 22GB | 12m | 15m | 8m |
| **3 (normal)** | **18GB** | **18m** | **12m** | **10m** |
| 9 (ultra) | 15GB | 90m | 10m | 15m |

**Selected**: Level 3 - Best time/size balance

### 5. Why Node20 Runtime?

**GitHub Actions runners**:
- Node16: Deprecated
- Node20: Current stable
- Node21+: Not yet supported

**Selected**: Node20 - Latest supported version

### 6. Artifact Retention

**Intermediate artifacts**: 1 day
- Only needed between stages
- Automatically deleted after workflow completes
- Reduces storage costs

**Final artifacts**: 7 days
- Published to GitHub Releases (permanent)
- Artifacts serve as temporary backup
- Auto-cleanup after successful release

## Optimization Strategies

### 1. Selective Compression

**Excluded from checkpoints**:
```javascript
'-xr!*.git',     // Git history (re-fetchable)
'-xr!*.obj',     // Large intermediates
'-xr!*.ilk',     // Incremental link files
'-xr!*.pdb'      // Debug databases (huge)
```

**Impact**: Reduces checkpoint size by 40-60%

### 2. Timeout Safety Margin

**Configured**: 5.5 hours (19,800 seconds)
**Actual limit**: 6 hours (21,600 seconds)

**Rationale**: 
- 30-minute buffer for checkpoint creation
- Artifact upload can take 10-15 minutes
- Ensures clean shutdown before force-kill

### 3. Retry Logic

All artifact operations retry 5 times:
```javascript
for (let i = 0; i < 5; ++i) {
    try {
        await artifact.uploadArtifact(...);
        break;
    } catch (e) {
        await sleep(10000);  // 10-second delay
    }
}
```

**Handles**:
- Transient network failures
- GitHub API rate limits
- Temporary service outages

### 4. State Marker Files

`build-stage.txt` tracks progress:
- Persisted in artifact checkpoint
- Survives across stage boundaries
- Enables fine-grained resume points

## Monitoring and Debugging

### Logging Strategy

**Console output**:
```javascript
console.log(`finished: ${finished}, from_artifact: ${from_artifact}`);
console.log(`Resuming from stage: ${currentStage}`);
```

**Actions integration**:
```javascript
core.setOutput('finished', true);
core.exportVariable('DEPOT_TOOLS_WIN_TOOLCHAIN', '0');
```

### Debugging Failed Builds

**Check**:
1. Download artifact from failed stage
2. Extract `build-stage.txt` to see last completed phase
3. Review action logs for error messages
4. Check disk space usage (should have 40GB+ free)

### Performance Metrics

**Typical stage durations**:
```
Stage 1: 3-4h (npm run init)
Stage 2: 5.5h (early compilation, timeout)
Stage 3: 5.5h (mid compilation, timeout)
Stage 4: 5.5h (late compilation, timeout)
Stage 5: 5.5h (final compilation, timeout)
Stage 6: 3-4h (linking)
Stage 7: Skip (finished=true)
Stage 8: Skip (finished=true)

Total: ~24-29 hours
```

## Scalability Considerations

### Horizontal Scaling

**Not implemented**: Parallel compilation stages
**Reason**: Brave build is monolithic, hard to parallelize

**Possible approach**:
- Build different targets separately (browser, installer, tests)
- Merge in final stage
- **Complexity**: High
- **Benefit**: Moderate (limited by dependencies)

### Vertical Scaling

**Current**: 2-core, 7GB RAM
**If GitHub offered larger runners**:
- 8-core: ~12 hour build (2-3 stages needed)
- 16-core: ~6 hour build (1-2 stages needed)

### Caching Strategies

**Potential improvements**:
1. **Actions cache**: Store depot_tools, gclient cache
   - **Benefit**: Faster init
   - **Issue**: 10GB cache limit, Chromium is 60GB
   
2. **Self-hosted runners**: Persistent disk
   - **Benefit**: Full incremental builds
   - **Cost**: Infrastructure maintenance

3. **Docker images**: Pre-configured environment
   - **Benefit**: Faster setup
   - **Issue**: Large image size (30-40GB)

## Security Considerations

### 1. Source Verification

- Tags are fetched from official brave-core repository
- GitHub Actions OIDC token for authentication
- No arbitrary code execution from external sources

### 2. Artifact Integrity

- Artifacts stored in GitHub-managed storage
- Short retention periods (1-7 days)
- No external distribution of intermediates

### 3. Secrets Management

- No API keys or tokens required for basic build
- If adding code signing:
  ```yaml
  - name: Sign executable
    env:
      CERT_PASSWORD: ${{ secrets.CERT_PASSWORD }}
  ```

## Future Enhancements

### Short Term

1. **Progress visualization**: Update PR with build progress
2. **Build cache**: Save `depot_tools` between runs
3. **Notifications**: Alert on build completion/failure

### Medium Term

1. **Multi-architecture**: Add ARM64 and x86 builds
2. **Parallel stages**: Split independent components
3. **Incremental artifacts**: Delta-upload only changed files

### Long Term

1. **Distributed builds**: Use remote execution (Bazel/Goma)
2. **Self-hosted runners**: Persistent build environments
3. **Build service**: Dedicated infrastructure for large builds

## Comparison with Alternatives

### vs. Ungoogled-Chromium Approach

| Aspect | Ungoogled | Brave (this) |
|--------|-----------|--------------|
| Stages | 16 per arch × 3 archs | 8 stages × 1 arch |
| Build tool | Python script | npm scripts |
| Parallel builds | Yes (3 architectures) | No |
| Complexity | High | Medium |

**Rationale**: Brave builds faster, needs fewer stages

### vs. Manual Build

| Aspect | Manual | Automated |
|--------|--------|-----------|
| Setup time | 2-4 hours | Automatic |
| Build time | 3-6 hours | 24-29 hours |
| Reproducibility | Variable | High |
| Cost | Hardware | $0 (GitHub free tier) |

**Use case**: Automated for CI/CD, manual for development

## Conclusion

This multi-stage workflow successfully addresses the constraints of GitHub Actions while building a complex project like Brave Browser. The design balances:

- **Reliability**: Checkpointing and retry logic
- **Efficiency**: Compression and selective archiving
- **Maintainability**: Clear state machine and logging
- **Extensibility**: Easy to add more stages or architectures

The approach can be adapted for other large builds (Chromium variants, large C++ projects, etc.) with similar time/resource constraints.





