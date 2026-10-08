# Releases

A release is built and published by `.github/workflows/release-binaries.yml`
when a tag `vMAJOR.MINOR.PATCH` is pushed. Every part gets the tag's version:
the server (`app.Version`), the desktop app (`scripts/set-desktop-version.mjs`
writes it into `tauri.conf.json` before the build) and the station packages
(`KESHER_VERSION` in `deploy/node/build.sh`).

## Making a release

1. Optional: write the notes as `docs/releases/<version>.md` (e.g.
   `0.9.0.md`, without the `v`) and commit them.
2. Check that everything builds without publishing: push a commit with
   `[full-build]` in its message, or run the workflow by hand
   (`gh workflow run "Release binaries" --ref <branch>`).
3. Tag and push:

   ```sh
   git tag v0.9.0
   git push origin v0.9.0
   ```

The release text is the notes file (if present), then
[downloads.md](downloads.md) (which file is what), then GitHub's generated
list of changes. When the set of files changes, update `downloads.md` and the
download section of the main README together.

Pre-release tags such as `v0.9.0-rc1` build too, but the desktop app keeps
the version from `tauri.conf.json` (a Windows MSI cannot carry `-rc1`).
