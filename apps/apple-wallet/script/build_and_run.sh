#!/usr/bin/env bash
set -euo pipefail
MODE="${1:-run}"
WALLET_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$WALLET_ROOT/../.." && pwd)"
APP_NAME="HeyunaWallet"
BUILD_DIR="$REPO_ROOT/.state/apple-wallet-run"
case "$MODE" in run|--debug|--logs|--telemetry|--verify) ;; *) echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2; exit 2;; esac
pkill -x "$APP_NAME" >/dev/null 2>&1 || true
python3 "$WALLET_ROOT/script/generate_project.py"
xcodebuild -project "$WALLET_ROOT/HeyunaWallet.xcodeproj" -scheme HeyunaWallet -configuration Debug -destination 'platform=macOS' -derivedDataPath "$BUILD_DIR" CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO build
APP_BUNDLE="$BUILD_DIR/Build/Products/Debug/$APP_NAME.app"
case "$MODE" in
    run) /usr/bin/open -n "$APP_BUNDLE";;
    --debug) lldb -- "$APP_BUNDLE/Contents/MacOS/$APP_NAME";;
    --logs) /usr/bin/open -n "$APP_BUNDLE"; /usr/bin/log stream --info --style compact --predicate 'process == "HeyunaWallet"';;
    --telemetry) /usr/bin/open -n "$APP_BUNDLE"; /usr/bin/log stream --info --style compact --predicate 'subsystem == "com.heyuna.wallet"';;
    --verify) /usr/bin/open -n "$APP_BUNDLE"; sleep 1; pgrep -x "$APP_NAME" >/dev/null;;
esac
