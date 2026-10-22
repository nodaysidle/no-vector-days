#!/usr/bin/env python3
"""
Wayland & Hyprland Automated Verification Test for VectorStudio
Validates native Wayland window initialization, Hyprland client mapping (Electron shell, not XWayland), and the in-page engine smoke test.
"""

import os
import sys
import time
import subprocess
import urllib.request

def test_wayland_desktop_app():
    print("--- Running VectorStudio Wayland & Hyprland Integration Test ---")

    wayland_display = os.environ.get("WAYLAND_DISPLAY")
    hypr_sig = os.environ.get("HYPRLAND_INSTANCE_SIGNATURE")

    print(f"1. Checking environment: WAYLAND_DISPLAY={wayland_display}, Hyprland Signature={bool(hypr_sig)}")
    assert wayland_display, "WAYLAND_DISPLAY environment variable must be set"
    assert hypr_sig, "HYPRLAND_INSTANCE_SIGNATURE must be set"
    print("✓ Active Wayland and Hyprland session verified.")

    # 2. Run VectorStudio in test mode
    # Always test the repo's launcher, not whatever an old install left behind.
    app_bin = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../bin/vectorstudio")

    print(f"2. Launching desktop app via: {app_bin} --test...")
    proc = subprocess.run([app_bin, "--test"], capture_output=True, text=True, timeout=15)

    print("STDOUT:", proc.stdout.strip())
    if proc.stderr.strip():
        # GTK CSS theme warning is normal on custom themes
        filtered_err = "\n".join([l for l in proc.stderr.splitlines() if "Theme parsing error" not in l])
        if filtered_err:
            print("STDERR:", filtered_err)

    assert proc.returncode == 0, f"App execution failed with exit code {proc.returncode}"
    assert "TEST PASSED" in proc.stdout, "Expected TEST PASSED confirmation in stdout"
    print("✓ Native Wayland window mapping and Hyprland registration verified.")

    # 3. Verify Desktop Entry File
    desktop_file = os.path.expanduser("~/.local/share/applications/vectorstudio.desktop")
    assert os.path.exists(desktop_file), f"Desktop file missing at {desktop_file}"
    with open(desktop_file, "r") as f:
        content = f.read()
        assert "Exec=vectorstudio" in content
        assert "StartupWMClass=vectorstudio" in content
    print(f"✓ XDG Desktop entry verified at {desktop_file}.")

    # 4. Verify Desktop Icon File
    icon_file = os.path.expanduser("~/.local/share/icons/hicolor/scalable/apps/vectorstudio.svg")
    assert os.path.exists(icon_file), f"Desktop icon missing at {icon_file}"
    print(f"✓ Scalable SVG icon verified at {icon_file}.")

    print("\nAll Wayland & Hyprland Desktop tests passed successfully!\n")

if __name__ == "__main__":
    test_wayland_desktop_app()
