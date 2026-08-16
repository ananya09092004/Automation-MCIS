# Bundling sox — so users NEVER install anything manually

## Why
node-record-lpcm16 shells out to the `sox` command to capture microphone audio.
Without it installed system-wide, voice fails for every user — not just you.
The fix: ship a portable copy of sox right next to the built .exe.

## One-time setup (you do this now, on your dev machine)

1. Download the **portable** SoX build for Windows (no installer, just files):
   https://sourceforge.net/projects/sox/files/sox/14.4.2/sox-14.4.2-win32.zip/download

2. Extract it. Inside you'll find `sox.exe` plus some `.dll` files.

3. Create this folder structure inside your `mcis-agent-final` project:
   ```
   mcis-agent-final/
   ├── bin/
   │   └── sox/
   │       ├── sox.exe
   │       ├── (all the .dll files from the zip)
   ```

4. `audioUtils.js` now automatically looks for `bin/sox/sox.exe` next to the
   built executable first, and only falls back to a system-installed `sox`
   if that's not found. This means:
   - **On your dev machine right now**: since there's no `bin/sox/sox.exe`
     yet, it'll still fall back to your manually-installed system sox — so
     your current testing keeps working without changes.
   - **After you build the .exe** (`npm run build`) and ship the `bin/`
     folder alongside `mcis-agent-win.exe`, every other user's copy will
     use the bundled sox automatically — they install nothing.

## When you build the final distributable

Your downloads page / installer package should contain:
```
mcis-agent-win.exe
bin/
  sox/
    sox.exe
    (dlls)
install-windows.ps1
```//
All in the same folder, so the relative path lookup in `audioUtils.js` finds
`bin/sox/sox.exe` next to the .exe correctly.

## Mac/Linux
Portable sox binaries are messier to bundle cross-platform (Mac needs
codesigning for downloaded binaries to run without security prompts,
Linux distros usually already have it via a one-line apt/brew install).
For now, Mac/Linux users still need `brew install sox` /
`sudo apt install sox` once — this is a smaller ask on those platforms
since package managers make it trivial. Bundling for those is a
future improvement, not urgent for a Windows-first launch.
