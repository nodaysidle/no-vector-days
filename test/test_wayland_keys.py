#!/usr/bin/env python3
"""
Real-keystroke test for VectorStudio on Hyprland.
Sends actual key events through the Wayland compositor with `wtype` (not synthetic DOM events).
The app runs with VECTORSTUDIO_PROBE=1, which seeds 5 layers and mirrors engine state into the
window title; the test reads that title back from `hyprctl clients -j`.
"""

import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
APP_BIN = os.path.join(HERE, "../bin/vectorstudio")

START = "probe:5:SELECT:1"
# (description, wtype args, expected title). The probe seeds 5 layers with the first selected.
STEPS = [
    ("Ctrl+D duplicates", ["-M", "ctrl", "-k", "d", "-m", "ctrl"], "probe:6:SELECT:1"),
    ("Ctrl+Z undoes", ["-M", "ctrl", "-k", "z", "-m", "ctrl"], "probe:5:SELECT:0"),
    ("Ctrl+Y redoes", ["-M", "ctrl", "-k", "y", "-m", "ctrl"], "probe:6:SELECT:1"),
    ("Delete removes selection", ["-k", "Delete"], None),
    ("Ctrl+A leaves tool alone", ["-M", "ctrl", "-k", "a", "-m", "ctrl"], None),
    ("P selects pen", ["-k", "p"], None),
    ("V selects select", ["-k", "v"], None),
]


def window():
    try:
        clients = json.loads(subprocess.run(["hyprctl", "clients", "-j"], capture_output=True, text=True, timeout=3).stdout)
    except (subprocess.SubprocessError, json.JSONDecodeError):
        return None
    return next((c for c in clients if c.get("class") == "vectorstudio"), None)


def title():
    w = window()
    return w["title"] if w else ""


def focus():
    subprocess.run(["hyprctl", "dispatch", "focuswindow", "class:vectorstudio"], capture_output=True, timeout=3)
    time.sleep(0.2)
    active = subprocess.run(["hyprctl", "activewindow", "-j"], capture_output=True, text=True, timeout=3).stdout
    return '"class": "vectorstudio"' in active


def wait_for_new_title(previous, timeout=2.0):
    end = time.time() + timeout
    while time.time() < end:
        got = title()
        if got != previous:
            return got
        time.sleep(0.1)
    return title()


def run_steps():
    end = time.time() + 15
    while title() != START:
        if time.time() > end:
            print(f"FAIL: app never reported ready (title={title()!r})")
            return False
        time.sleep(0.2)

    last = START
    for desc, keys, expected in STEPS:
        if not focus():
            print(f"FAIL: could not focus the app window before: {desc}")
            return False
        subprocess.run(["wtype", "-s", "80"] + keys, timeout=3)
        got = wait_for_new_title(last)
        _, count, tool, sel = got.split(":")[0:4] if got.startswith("probe:") else ("", "", "", "")
        checks = {
            "Delete removes selection": lambda: count == "5" and sel == "0",
            "Ctrl+A leaves tool alone": lambda: tool == "SELECT",
            "P selects pen": lambda: tool == "PEN",
            "V selects select": lambda: tool == "SELECT",
        }
        ok = (got == expected) if expected else checks[desc]()
        print(f"{'✓' if ok else '✗'} {desc} -> {got}")
        if not ok:
            print(f"FAIL at: {desc}")
            return False
        last = got
    print("All real-keystroke checks passed.")
    return True


def main():
    proc = subprocess.Popen([APP_BIN], env={**os.environ, "VECTORSTUDIO_PROBE": "1"},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ok = run_steps()
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
