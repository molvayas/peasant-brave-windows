# Peasant Brave Windows

Automated multi-stage GitHub Actions workflow for building Brave Browser on Windows.

## Overview

This repository uses a sophisticated multi-stage build approach to compile Brave Browser on GitHub Actions runners, working around the 6-hour runner timeout limitation. The build is split into 8 sequential stages, each saving and restoring build state.

## Features

- **Multi-stage incremental builds** - Checkpoint and resume across multiple runner instances
- **Artifact persistence** - Intermediate build states saved between stages
- **Automatic retry logic** - Robust artifact upload with 5 retry attempts
- **Version-tagged builds** - Uses Brave version tags for reproducible builds
- **Automatic releases** - Publishes built binaries to GitHub Releases

## How It Works

### Workflow Structure

The workflow consists of:
1. **8 sequential build stages** (`build-1` through `build-8`)
2. **Checkpoint system** - Each stage saves progress if build isn't complete
3. **Resume capability** - Next stage downloads and continues from checkpoint
4. **Final packaging** - Last stage publishes release artifacts

### Build Stages

Each stage performs:
1. Downloads previous build state (if available)
2. Continues compilation from where it left off
3. Runs for up to 5.5 hours
4. Either:
   - **Success**: Uploads final package and sets `finished: true`
   - **Timeout**: Compresses `src/` directory and uploads checkpoint

### Stage Action (`/.github/actions/stage/`)

The custom action manages:
- **Brave initialization**: Clones brave-core at specified version tag
- **Dependency setup**: Runs `npm run init` to fetch Chromium and dependencies
- **Incremental compilation**: Executes `npm run build Release`
- **State management**: Tracks progress with marker files (`build-stage.txt`)
- **Artifact handling**: Uploads intermediate states or final packages

## Usage

### Trigger Build

**Via Git Tag:**
```bash
git tag v1.71.121
git push origin v1.71.121
```

**Via Workflow Dispatch:**
1. Go to Actions tab
2. Select "Build Brave Browser" workflow
3. Click "Run workflow"
4. Enter Brave version tag (e.g., `v1.71.121`)

### Version Format

Use Brave's release tags from https://github.com/brave/brave-core/tags

Examples:
- `v1.71.121`
- `v1.70.126`
- `v1.69.168`

## Build Output

Successful builds produce:
- `BraveBrowser*.exe` - Windows installer (if available)
- `brave-browser-{version}-win-x64.zip` - Portable browser package

Artifacts are published to GitHub Releases automatically.

## Requirements

- GitHub repository with Actions enabled
- No additional setup required (all dependencies installed during workflow)

## Technical Details

### Build Environment

- **Runner**: `windows-2022`
- **Node.js**: v24
- **Python**: 3.12
- **Build directory**: `C:\brave-build`
- **Compression**: 7-Zip with level 3 for checkpoints

### Artifact Strategy

**Intermediate artifacts** (`build-artifact`):
- Contains compressed `src/` directory
- Excludes: `.git`, `.obj`, `.ilk`, `.pdb` files
- Retention: 1 day
- Compression level: 3 (balanced speed/size)

**Final artifacts** (`brave-browser`):
- Contains installers or packaged executables
- Retention: 7 days
- Compression level: 0 (no additional compression)

### Environment Variables

Set during build:
- `DEPOT_TOOLS_WIN_TOOLCHAIN=0` - Use local Visual Studio
- `PYTHONUNBUFFERED=1` - Immediate stdout output
- `GSUTIL_ENABLE_LUCI_AUTH=0` - Disable Google auth

## Troubleshooting

### Build Fails in Stage 1

- Check that the Brave version tag exists
- Verify network connectivity for Chromium downloads
- Review logs for `npm run init` errors

### Build Stalls

- Each stage has 5.5-hour timeout
- If consistently timing out, increase number of stages in `main.yml`

### Artifact Upload Fails

- Action retries 5 times with 10-second delays
- Check GitHub Actions artifact storage limits
- Verify repository permissions

## Extending

### Add More Stages

To increase build stages (if needed):

```yaml
build-9:
  needs: build-8
  runs-on: windows-2022
  steps:
    # ... copy from build-8 and update needs reference
```

### Modify Build Configuration

Edit `index.js` to customize:
- Build type: Change `Release` to `Debug` or `Component`
- Target architecture: Add `--target_arch=x86` or `--target_arch=arm64`
- Build flags: Modify npm run build arguments

## References

- [Brave Browser Build Guide](https://github.com/brave/brave-browser/wiki)
- [Windows Development Environment](https://github.com/brave/brave-browser/wiki/Windows-Development-Environment)
- [Brave Core Repository](https://github.com/brave/brave-core)

## License

This build automation is independent tooling. Brave Browser itself is licensed under MPL 2.0.

## Credits

Inspired by the ungoogled-chromium-windows multi-stage build approach.

