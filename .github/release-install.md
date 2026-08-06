
## Install

Already running Second Brain? You do not need this page — the app finds the release itself and
offers it in the footer. This is for a first install, or for the builds that cannot replace
themselves (the portable exe, and macOS while it is signed ad-hoc).

**Windows** — download the `Setup` installer and run it.

**macOS** — download the `.dmg` for your chip (`arm64` for Apple Silicon, `x64` for Intel) and
drag the app to Applications.

This build is not notarized by Apple, so the first launch is blocked. Right-click the app and
choose **Open**, then confirm — once only. If macOS still refuses, clear the quarantine flag:

```
xattr -dr com.apple.quarantine "/Applications/Second Brain.app"
```

## Before it will do anything

Second Brain drives your own Claude subscription through the `claude` CLI. Install it and sign
in first: https://claude.com/claude-code
