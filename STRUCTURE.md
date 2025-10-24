# Brave Build Directory Structure

This document explains the directory structure used for building Brave Browser, following the official Brave build conventions.

## Directory Layout

```
C:\brave-build/                    # Root build directory (short path)
├── src/                           # Source root (gclient workspace)
│   ├── brave/                     # brave-core repository
│   │   ├── .env                   # Build configuration (optional)
│   │   ├── .git/                  # Git repository
│   │   ├── package.json           # npm configuration
│   │   ├── DEPS                   # Dependency manifest
│   │   ├── patches/               # Chromium patches
│   │   │   ├── *.patch            # Patch files
│   │   │   └── *.patchinfo        # Patch state tracking
│   │   ├── browser/               # Brave browser code
│   │   ├── components/            # Brave components
│   │   ├── chromium_src/          # Chromium overrides
│   │   └── ...
│   │
│   ├── chrome/                    # Chromium browser (fetched by gclient)
│   ├── chromium/                  # Chromium base
│   ├── third_party/               # Third-party dependencies
│   ├── build/                     # Build scripts
│   ├── tools/                     # Build tools
│   ├── out/                       # Build output directory
│   │   └── Release/               # Release build artifacts
│   │       ├── brave.exe          # Main executable
│   │       ├── *.dll              # Dynamic libraries
│   │       ├── *.pak              # Resource packages
│   │       ├── locales/           # Localized resources
│   │       ├── obj/               # Object files (intermediate)
│   │       └── gen/               # Generated sources
│   │
│   └── .gclient                   # gclient configuration (root marker)
│
└── build-stage.txt                # Build progress marker

After stage completion:
C:\brave-build/
└── build-state.zip                # Checkpoint artifact (uploaded to GitHub)
```

## Official Brave Structure

According to Brave's documentation, the repository layout follows this pattern:

```
brave-browser/                     # Normally the project root
└── src/
    ├── brave/                     # brave-core (git clone)
    └── ...                        # Chromium + dependencies (gclient sync)
```

For GitHub Actions, we adapt this to:
- Use `C:\brave-build` as root (short path to avoid Windows limits)
- Clone brave-core to `C:\brave-build\src\brave`
- Let gclient populate the rest of `src/`

## Why This Structure?

### 1. Following Official Convention

From Brave's README.md:
```bash
git clone git@github.com:brave/brave-core.git path-to-your-project-folder/src/brave
cd path-to-your-project-folder/src/brave
npm install
npm run init
```

The key points:
- brave-core must be at `src/brave`
- npm commands run from `src/brave` directory
- gclient creates `.gclient` at project root (one level above `src/`)

### 2. gclient Expectations

gclient sync expects:
- `.gclient` file at root
- `src/` subdirectory
- brave-core at `src/brave`

This is defined in `.gclient`:
```python
solutions = [{
    "name": "src",
    "url": "https://github.com/brave/chromium",
    ...
  }, {
    "name": "src/brave",
    "url": "https://github.com/brave/brave-core.git"
  }
]
```

### 3. Short Path Requirement

Windows has a 260-character path limit (MAX_PATH). Chromium's deep directory structure can exceed this:

**Bad** (long path):
```
D:\a\peasant-brave-windows\peasant-brave-windows\brave-build\src\third_party\webrtc\modules\...
└── 140+ characters just to get here
```

**Good** (short path):
```
C:\brave-build\src\third_party\webrtc\modules\...
└── Only 45 characters to get here
```

## Key Directories Explained

### src/brave/ (brave-core)

This is the **Brave-specific code**:
- Custom features (Rewards, Wallet, VPN, etc.)
- Chromium patches
- Build configuration
- npm scripts that orchestrate the build

**Cloned explicitly** in our workflow:
```javascript
await exec.exec('git', ['clone', '--branch', brave_version, '--depth=1',
    'https://github.com/brave/brave-core.git', 'C:\\brave-build\\src\\brave']);
```

### src/chrome/ (Chromium browser)

The upstream Chromium browser code.

**Fetched by** `npm run init` via gclient.

### src/out/Release/

Build output directory created by `gn gen` and `ninja`.

Contains:
- **brave.exe** - Main browser executable (~150MB)
- **DLLs** - chrome_elf.dll, libEGL.dll, etc.
- **PAK files** - Compressed resources
- **obj/** - Compiled object files (~40GB)
- **gen/** - Generated source files (~2GB)

### src/.gclient

Created by `npm run init`, contains:
```python
solutions = [
  {
    "name": "src",
    "managed": False,
    "url": "https://github.com/brave/chromium",
    "custom_deps": {...},
    "custom_vars": {...}
  },
  {
    "name": "src/brave",
    "managed": False,
    "url": "https://github.com/brave/brave-core.git"
  }
]
```

This tells gclient:
- Download Chromium to `src/`
- brave-core is already at `src/brave` (managed: False)
- Apply custom dependencies and variables

## Build Flow

### Stage 1: Clone brave-core

```bash
git clone --branch v1.71.121 --depth=1 \
  https://github.com/brave/brave-core.git \
  C:\brave-build\src\brave
```

Creates:
```
C:\brave-build\src\brave\
├── package.json
├── DEPS
├── patches/
└── ...
```

### Stage 2: Install npm dependencies

```bash
cd C:\brave-build\src\brave
npm install
```

Installs:
- depot_tools wrapper
- Build scripts
- Node.js dependencies

### Stage 3: Initialize (npm run init)

```bash
npm run init -- --no-history
```

Under the hood:
1. Creates `C:\brave-build\.gclient`
2. Runs `gclient sync --no-history`
3. Downloads Chromium + 240 dependencies (~10GB with --no-history)
4. Applies Brave patches from `patches/`

Result:
```
C:\brave-build\
├── .gclient
└── src\
    ├── brave\         (already there)
    ├── chrome\        (new)
    ├── chromium\      (new)
    ├── third_party\   (new)
    └── ...            (240+ repos)
```

### Stage 4: Build (npm run build)

```bash
npm run build Release
```

Under the hood:
1. Runs `gn gen src/out/Release`
2. Runs `autoninja -C src/out/Release`
3. Compiles ~40,000 source files
4. Links executables

Creates:
```
src\out\Release\
├── brave.exe
├── *.dll
└── *.pak
```

## Checkpoint Contents

When creating a checkpoint (intermediate artifact), we compress:

```
build-state.zip
├── src/                           # Entire source tree
│   ├── brave/                     # Preserved: git repo + patches
│   ├── chrome/                    # Preserved: source code
│   ├── out/Release/obj/           # Preserved: compiled objects
│   └── out/Release/gen/           # Preserved: generated code
│
└── .gclient                       # Preserved: gclient config

Excluded:
- src/**/.git/                     # Git history (too large, re-fetchable)
- src/out/Release/*.obj            # Individual obj files (kept in obj/)
- src/out/Release/*.ilk            # Incremental link files
- src/out/Release/*.pdb            # Debug databases
```

**Size comparison**:
- Full directory: ~80-100GB
- Compressed (level 3): ~18-25GB
- Excludes git history: ~60GB saved
- Excludes debug files: ~10GB saved

## Path Length Management

Windows MAX_PATH is 260 characters. Deepest paths in Chromium:

```
C:\brave-build\src\third_party\blink\renderer\core\css\properties\longhands\
└── 78 characters (leaves 182 for filename)

vs.

D:\a\peasant-brave-windows\peasant-brave-windows\brave-build\src\third_party\blink\...
└── 108 characters (leaves 152 for filename)
```

By using `C:\brave-build`, we save ~30 characters across thousands of files.

## Comparison: Local vs. CI Structure

### Local Development

Recommended by Brave:
```
C:\                                # Clone to C:\ root
└── brave-browser\
    └── src\
        └── brave\
```

Commands:
```bash
git clone git@github.com:brave/brave-core.git C:\brave-browser\src\brave
cd C:\brave-browser\src\brave
npm install
npm run init
npm run build
```

### CI (This Workflow)

Adapted for GitHub Actions:
```
C:\brave-build\                    # Different name to avoid conflicts
└── src\
    └── brave\
```

Differences:
- No parent `brave-browser` directory (not needed)
- Direct clone to `src\brave`
- Automated version selection
- Checkpoint/resume capability

## References

- [Brave Browser README](https://github.com/brave/brave-browser/blob/master/README.md)
- [Brave Build Deconstructed](https://github.com/brave/brave-browser/wiki/Brave-Browser-Build-Deconstructed-‐-overview-of-the-underlying-tools)
- [Windows Development Environment](https://github.com/brave/brave-browser/wiki/Windows-Development-Environment)
- [Chromium Windows Build Instructions](https://chromium.googlesource.com/chromium/src/+/master/docs/windows_build_instructions.md)



