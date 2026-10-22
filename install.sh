#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
APP_DIR="${HOME}/.local/share/applications"
ICON_DIR="${HOME}/.local/share/icons/hicolor/scalable/apps"
SHARE_DIR="${HOME}/.local/share/vectorstudio"

if ! command -v "${VECTORSTUDIO_ELECTRON:-electron43}" >/dev/null 2>&1; then
    echo "[VectorStudio Installer] Missing ${VECTORSTUDIO_ELECTRON:-electron43}. Install it first: sudo pacman -S electron43" >&2
    exit 1
fi

mkdir -p "${BIN_DIR}" "${APP_DIR}" "${ICON_DIR}"

echo "[VectorStudio Installer] Installing to Omarchy user desktop..."

# 1. Copy the app (shell, preload, launcher, editor) so the install keeps working if this clone moves
echo "  ✓ Copying VectorStudio to ${SHARE_DIR}..."
mkdir -p "${SHARE_DIR}"
# Replace only what this installer owns, so stale editor files never linger and nothing else here is touched.
rm -rf "${SHARE_DIR}/app" "${SHARE_DIR}/bin" "${SHARE_DIR}/main.cjs" "${SHARE_DIR}/preload.cjs" "${SHARE_DIR}/vectorstudio.svg"
cp -r "${DIR}/main.cjs" "${DIR}/preload.cjs" "${DIR}/vectorstudio.svg" "${DIR}/bin" "${DIR}/app" "${SHARE_DIR}/"

# 2. Install launcher symlink
ln -sf "${SHARE_DIR}/bin/vectorstudio" "${BIN_DIR}/vectorstudio"
echo "  ✓ Installed binary: ${BIN_DIR}/vectorstudio"

# 3. Install desktop icon
cp "${DIR}/vectorstudio.svg" "${ICON_DIR}/vectorstudio.svg"
echo "  ✓ Installed icon: ${ICON_DIR}/vectorstudio.svg"

# 4. Install desktop entry
cp "${DIR}/vectorstudio.desktop" "${APP_DIR}/vectorstudio.desktop"
echo "  ✓ Installed desktop entry: ${APP_DIR}/vectorstudio.desktop"

# Refresh desktop database if tool is installed
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "${APP_DIR}" >/dev/null 2>&1 || true
fi

echo "[VectorStudio Installer] Complete! VectorStudio is now registered in your application menu and runnable via 'vectorstudio'."
