# Brave Build Process Notes

## Understanding Brave's Build System

Brave Browser is built on top of Chromium with custom patches and features. The build process involves:

### 1. Repository Structure

```
brave-build/
└── src/
    ├── brave/          # brave-core repository
    ├── chrome/         # Chromium browser
    ├── chromium/       # Chromium base
    └── out/
        └── Release/    # Build output
```

### 2. Build Phases

#### Phase 1: Initialization (`npm run init`)

This downloads ~60GB of dependencies:
- Chromium source code (via depot_tools/gclient)
- ~240 dependent repositories
- Build tools and SDKs
- Platform-specific dependencies

**Time estimate**: 1-3 hours depending on network speed

**Environment setup**:
- Creates `.gclient` configuration file
- Sets up depot_tools
- Configures gclient for Windows platform
- Downloads Visual Studio toolchain (if using hermetic toolchain)

#### Phase 2: Patching

Brave applies custom patches from `brave-core/patches/`:
- Chromium modifications
- Feature additions
- Privacy enhancements
- Branding changes

**Tracked in**: `brave/patches/*.patchinfo` files

#### Phase 3: Build Configuration (`gn gen`)

Generates Ninja build files based on:
- Build type (Release, Debug, Component, Static)
- Target platform and architecture
- GN args from `.env` file or command line

#### Phase 4: Compilation (`autoninja`)

Compiles ~40,000+ source files:
- C++ compilation
- JavaScript bundling
- Resource processing
- Linking

**Time estimate**: 3-8 hours for full build, 30-60 minutes for incremental

### 3. Build Artifacts

After successful compilation:

**Main executable**: `out/Release/brave.exe`
**Supporting files**:
- `*.dll` - Dynamic libraries
- `*.pak` - Resource packages
- `locales/*.pak` - Language files
- `chrome_100_percent.pak`, `chrome_200_percent.pak` - UI resources

**Installer** (if mini_installer target built): `out/Release/BraveBrowserSetup.exe`

### 4. Multi-Stage Strategy

Our workflow splits the build because:

1. **Total time**: 5-12 hours (exceeds 6-hour GitHub Actions limit)
2. **Network phase**: Initial download is I/O bound
3. **Compile phase**: CPU-intensive, can timeout
4. **Checkpoint system**: Resume from failure points

#### Stage Breakdown

| Stage | Primary Task | Est. Time | Checkpoint Location |
|-------|--------------|-----------|---------------------|
| 1-2 | `npm run init` | 2-4h | After gclient sync |
| 3-5 | Early compilation | 4-6h | Partial object files |
| 6-7 | Late compilation | 2-4h | Nearly complete |
| 8 | Linking & packaging | 1-2h | Final artifacts |

### 5. Incremental Build Optimization

The workflow preserves:
- **`src/.gclient`** - Depot tools state
- **`src/out/Release/obj/`** - Compiled object files
- **`src/out/Release/gen/`** - Generated source files
- **Build markers** - Progress tracking

Not preserved (excluded from checkpoint):
- `.git/` directories - Can be re-fetched
- `.obj`, `.ilk`, `.pdb` debug intermediates (large)
- Temporary files

### 6. Key Differences from Chromium

| Aspect | Chromium | Brave |
|--------|----------|-------|
| Entry point | `gclient` + `gn` | `npm run init` + `npm run build` |
| Patches | None | ~300+ patches in `brave-core` |
| Branding | Chrome | Brave |
| Default features | Google services | Privacy-first |
| Build wrapper | Python/gn directly | npm scripts |

### 7. Windows-Specific Considerations

**Path lengths**:
- Maximum Windows path: 260 characters
- Brave build can exceed this in deep directories
- **Solution**: Build in `C:\brave-build` (short root path)

**Antivirus exclusions**:
- Defender can slow build by 10-50%
- Add exclusions for build directory
- Especially important for ninja (rapid file creation)

**Visual Studio**:
- Requires VS 2022 Update 17.8.3+
- Windows 11 SDK (works on Windows 10)
- Can use hermetic toolchain instead

**Filesystem**:
- NTFS required
- Case-insensitive (potential issues with Linux-built files)
- Cannot build from network-mounted drives

### 8. Build Configuration Options

#### Build Types

```bash
npm run build              # Component (default, fast incremental)
npm run build Release      # Optimized release build
npm run build Debug        # Debug symbols included
npm run build Static       # Statically linked (slower build, faster startup)
```

#### GN Args (in brave/.env)

```
is_official_build = true          # Full optimizations
enable_nacl = false               # Disable Native Client
is_component_build = false        # Static linking
symbol_level = 1                  # Minimal symbols
blink_symbol_level = 0           # No Blink symbols
enable_brave_ads = true           # Enable Brave Ads
```

### 9. Troubleshooting Build Issues

**Issue**: "Path too long"
- **Solution**: Use shorter root path (C:\brave-build)

**Issue**: Out of disk space
- **Symptom**: Build fails during compilation
- **Requirement**: ~120GB free space minimum
- **Solution**: Clean old build artifacts or use larger disk

**Issue**: Out of memory
- **Symptom**: Linker crashes or system freezes
- **Requirement**: 32GB RAM recommended for parallel builds
- **Solution**: Reduce ninja parallelism with `NINJA_JOBS=4`

**Issue**: gclient sync fails
- **Causes**: Network timeouts, Git LFS issues
- **Solution**: Retry with `npm run sync -- --force`

**Issue**: Patches fail to apply
- **Symptom**: `npm run init` errors with patch conflicts
- **Cause**: Chromium version mismatch
- **Solution**: Ensure brave-core version matches expected Chromium version

### 10. Performance Optimization

**Recommended system**:
- CPU: 16+ cores (Ryzen 9 / Core i9)
- RAM: 64GB (32GB minimum)
- Storage: NVMe SSD with 150GB+ free
- Network: Fast internet for initial download

**GitHub Actions runner specs**:
- CPU: 2-core
- RAM: 7GB
- Storage: 14GB SSD
- **Result**: Very slow, hence multi-stage approach needed

**Build time comparison**:
| System | Full Build | Incremental |
|--------|------------|-------------|
| High-end workstation | 2-3h | 10-20m |
| Mid-range desktop | 4-6h | 30-45m |
| GitHub Actions (single stage) | Times out (>6h) | - |
| GitHub Actions (multi-stage) | 8-20h total | N/A |

### 11. Artifact Sizes

**Uncompressed build directory**: ~80-100GB
**Compressed checkpoint**: ~15-25GB (7z level 3)
**Final package**: ~200-300MB
**Full installer**: ~150-200MB

### 12. Future Improvements

Potential optimizations for this workflow:
1. **Parallel stages** - Build different components simultaneously
2. **Ccache/sccache** - Distributed compilation cache
3. **Prebuilt dependencies** - Cache common third-party libs
4. **Incremental artifacts** - Save only changed object files
5. **Build containers** - Docker with pre-configured environment

## References

- [Brave Build Configuration](https://github.com/brave/brave-browser/wiki/Build-configuration)
- [Chromium Windows Build Instructions](https://chromium.googlesource.com/chromium/src/+/master/docs/windows_build_instructions.md)
- [GN Reference](https://gn.googlesource.com/gn/+/main/docs/reference.md)
- [Ninja Build System](https://ninja-build.org/manual.html)

