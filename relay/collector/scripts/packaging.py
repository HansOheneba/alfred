#!/usr/bin/env python3
"""Build a copy-only macOS installer. Never install, launch, or notarize it."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import stat
import subprocess
import tempfile
import zipfile
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]
BUNDLE_ID = "com.hansopoku.alfred.collector"
APP_NAME = "Alfred Collector.app"
EXPECTED_ENTITLEMENTS = {
    "com.apple.security.app-sandbox": True,
    "com.apple.security.network.client": True,
    "com.apple.security.temporary-exception.files.home-relative-path.read-only": [
        "/Library/Messages/chat.db", "/Library/Messages/chat.db-wal", "/Library/Messages/chat.db-shm",
    ],
}
MAX_ARCHIVE_BYTES = 100 * 1024 * 1024


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=True, capture_output=True)


def extract_development_archive(archive: Path, destination: Path) -> Path:
    """Only our one bounded app bundle; no traversal, links, or private state."""
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if not entries or len(entries) > 1000 or sum(e.file_size for e in entries) > MAX_ARCHIVE_BYTES:
            raise ValueError("Unexpected app archive size.")
        names = set()
        for entry in entries:
            path = PurePosixPath(entry.filename)
            mode = entry.external_attr >> 16
            canonical = path.as_posix()
            if (canonical.casefold() in names or entry.filename.rstrip("/") != canonical
                    or not path.parts or path.parts[0] != APP_NAME
                    or path.is_absolute() or ".." in path.parts or "\\" in entry.filename
                    or stat.S_ISLNK(mode) or (mode and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)))):
                raise ValueError("Unsafe app archive entry.")
            names.add(canonical.casefold())
            target = destination.joinpath(*path.parts)
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(bundle.read(entry))
                target.chmod(0o755 if mode & 0o111 else 0o644)
    return destination / APP_NAME


def validate_layout(app: Path) -> dict:
    if app.name != APP_NAME or app.is_symlink() or not app.is_dir():
        raise ValueError("Expected the Alfred Collector app bundle.")
    allowed_files = {"Contents/Info.plist", "Contents/MacOS/AlfredCollector",
                     "Contents/Resources/README.md", "Contents/Resources/LaunchAgent.plist.template",
                     "Contents/_CodeSignature/CodeResources"}
    for item in app.rglob("*"):
        if item.is_symlink() or not (item.is_file() or item.is_dir()):
            raise ValueError("App bundles with links or special files are not accepted.")
        if item.name.lower() in {"config.json", "account.json", "outbox.sqlite", ".env"}:
            raise ValueError("Private collector state cannot be packaged.")
        if item.is_file() and item.relative_to(app).as_posix() not in allowed_files:
            raise ValueError("Unexpected bundle resource; review it before packaging.")
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    if (info.get("CFBundleIdentifier") != BUNDLE_ID
            or info.get("CFBundleExecutable") != "AlfredCollector"
            or info.get("LSMinimumSystemVersion") != "27.0"
            or not re.fullmatch(r"\d+(?:\.\d+){0,2}", str(info.get("CFBundleShortVersionString", "")))
            or not re.fullmatch(r"\d+(?:\.\d+){0,2}", str(info.get("CFBundleVersion", "")))):
        raise ValueError("Unexpected bundle identity, version, or supported macOS declaration.")
    return info


def validate_signed_app(app: Path, team_id: str | None) -> dict:
    info = validate_layout(app)
    run("codesign", "--verify", "--strict", str(app))
    entitlements = plistlib.loads(run("codesign", "-d", "--entitlements", ":-", str(app)).stdout)
    if (entitlements != EXPECTED_ENTITLEMENTS
            or type(entitlements.get("com.apple.security.app-sandbox")) is not bool
            or type(entitlements.get("com.apple.security.network.client")) is not bool):
        raise ValueError("App sandbox scope differs from the reviewed scope.")
    metadata = run("codesign", "-d", "--verbose=4", str(app)).stderr.decode("utf-8")
    if team_id:
        if (not re.fullmatch(r"[A-Z0-9]{10}", team_id)
                or f"TeamIdentifier={team_id}\n" not in metadata
                or not re.search(r"^Authority=Developer ID Application: .+ \(" + team_id + r"\)$", metadata, re.M)
                or not re.search(r"^CodeDirectory .*flags=.*runtime", metadata, re.M)
                or not re.search(r"^Timestamp=.+", metadata, re.M)):
            raise ValueError("A timestamped, hardened-runtime Developer ID app for the specified team is required.")
    elif "Signature=adhoc" not in metadata:
        raise ValueError("Development packaging only accepts the local ad-hoc candidate.")
    binary = app / "Contents/MacOS/AlfredCollector"
    if run("lipo", "-archs", str(binary)).stdout.decode().split() != ["arm64"]:
        raise ValueError("Only the reviewed Apple Silicon candidate is supported.")
    build = run("vtool", "-show-build", str(binary)).stdout.decode()
    minimum = re.findall(r"^\s*minos\s+(\S+)\s*$", build, re.M)
    platforms = re.findall(r"^\s*platform\s+(\S+)\s*$", build, re.M)
    if minimum != ["27.0"] or platforms != ["MACOS"]:
        raise ValueError("The installer cannot advertise a platform different from the actual binary.")
    return info


def copy_bundle(source: Path, destination: Path) -> None:
    """Copy validated source bytes without resource forks or writable modes."""
    validate_layout(source)
    destination.mkdir(mode=0o755)
    for source_path in sorted(source.rglob("*")):
        relative = source_path.relative_to(source)
        target = destination / relative
        if source_path.is_dir():
            target.mkdir(mode=0o755)
        else:
            target.write_bytes(source_path.read_bytes())
            target.chmod(0o755 if relative.as_posix() == "Contents/MacOS/AlfredCollector" else 0o644)


def distribution_xml(version: str, development: bool) -> str:
    title = "Alfred Collector — inactive development preview" if development else "Alfred Collector"
    return f'''<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>{escape(title)}</title>
  <options customize="never" require-scripts="false" hostArchitectures="arm64"/>
  <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
  <allowed-os-versions><os-version min="27.0"/></allowed-os-versions>
  <welcome file="welcome.html"/>
  <conclusion file="conclusion.html"/>
  <choices-outline><line choice="collector"/></choices-outline>
  <choice id="collector" visible="false"><pkg-ref id="{BUNDLE_ID}.installer"/></choice>
  <pkg-ref id="{BUNDLE_ID}.installer" version="{escape(version)}" onConclusion="none">collector.pkg</pkg-ref>
</installer-gui-script>
'''


def bundle_tree_hash(app: Path) -> str:
    """Bind the installer to every reviewed file byte and directory name."""
    validate_layout(app)
    entries = []
    for path in sorted(app.rglob("*")):
        entries.append([path.relative_to(app).as_posix(), "directory" if path.is_dir() else "file",
                        None if path.is_dir() else hashlib.sha256(path.read_bytes()).hexdigest()])
    return hashlib.sha256(json.dumps(entries, separators=(",", ":")).encode()).hexdigest()


def validate_expanded_package(expanded: Path, expected_app_hash: str | None = None) -> Path:
    """Inspect the produced archive, without invoking Installer or package scripts."""
    packages = list(expanded.rglob("PackageInfo"))
    if len(packages) != 1:
        raise ValueError("Expected one component package.")
    from xml.etree import ElementTree as ET
    package = ET.fromstring(packages[0].read_bytes())
    if package.get("identifier") != BUNDLE_ID + ".installer" or package.get("install-location") != "/Applications":
        raise ValueError("Unexpected package destination or identity.")
    if package.find("scripts") is not None or any(p.name == "Scripts" for p in expanded.rglob("*")):
        raise ValueError("Installer scripts are forbidden.")
    payload = packages[0].parent / "Payload"
    if not payload.is_dir() or [p.name for p in payload.iterdir()] != [APP_NAME]:
        raise ValueError("The installer must contain only the app.")
    app = payload / APP_NAME
    validate_layout(app)
    if expected_app_hash is not None and bundle_tree_hash(app) != expected_app_hash:
        raise ValueError("Expanded installer app differs from the reviewed signed copy.")
    return app


def build_package(mode: str, app: Path | None, team_id: str | None, installer_identity: str | None) -> Path:
    development = mode == "development"
    if development and any([app, team_id, installer_identity]):
        raise ValueError("Development mode only uses the staged local archive; no signing identity accepted.")
    if not development and (not app or not team_id or not installer_identity
            or not re.fullmatch(r"Developer ID Installer: .+ \(" + re.escape(team_id or "") + r"\)", installer_identity or "")):
        raise ValueError("Release candidates require an explicitly selected signed app, team, and Developer ID Installer identity.")
    output_dir = ROOT / "build"
    if output_dir.is_symlink():
        raise ValueError("Refusing a symlinked build directory.")
    output_dir.mkdir(exist_ok=True)
    name = "Alfred Collector DEVELOPMENT.pkg" if development else "Alfred Collector RELEASE CANDIDATE.pkg"
    output = output_dir / name
    manifest = output_dir / ("development-package.json" if development else "release-candidate-package.json")
    if output.exists() or output.is_symlink() or manifest.exists() or manifest.is_symlink():
        raise ValueError("Package output already exists; review/remove the old build artifact first.")
    with tempfile.TemporaryDirectory(prefix="alfred-collector-package-") as temporary:
        temp = Path(temporary)
        source = extract_development_archive(output_dir / (APP_NAME + ".zip"), temp / "input") if development else app
        assert source is not None
        info = validate_signed_app(source, team_id)
        payload = temp / "root"
        payload.mkdir()
        # Copy bytes and executable modes only, not FileProvider/Finder metadata.
        copy_bundle(source, payload / APP_NAME)
        validate_signed_app(payload / APP_NAME, team_id)
        expected_app_hash = bundle_tree_hash(payload / APP_NAME)
        components = [{"RootRelativeBundlePath": APP_NAME, "BundleIsRelocatable": False,
                       "BundleIsVersionChecked": True, "BundleHasStrictIdentifier": True,
                       "BundleOverwriteAction": "upgrade"}]
        (temp / "components.plist").write_bytes(plistlib.dumps(components))
        run("pkgbuild", "--root", str(payload), "--component-plist", str(temp / "components.plist"),
            "--identifier", BUNDLE_ID + ".installer", "--version", info["CFBundleVersion"],
            "--install-location", "/Applications", "--ownership", "recommended", str(temp / "collector.pkg"))
        resources = temp / "resources"
        resources.mkdir()
        prefix = "<p><strong>Development preview: not notarized or runtime verified. Do not distribute.</strong></p>" if development else ""
        (resources / "welcome.html").write_text("<html><body><h1>Alfred Collector</h1>" + prefix +
            "<p>For Apple Silicon Macs running macOS 27 or later.</p><p>This installer only copies the app to Applications. "
            "It does not connect an account, read Messages, send alerts, enable notifications or start a background service.</p>"
            "<p>For an update, stop the collector first. Existing private pending alerts and settings are retained.</p></body></html>")
        (resources / "conclusion.html").write_text("<html><body><h1>App copied</h1>"
            "<p>Collection remains off until you explicitly complete setup. Installing is separate from granting Messages access.</p>"
            "<p>Do not delete the collector's private data to fix setup problems; it may contain alerts waiting for delivery.</p></body></html>")
        (temp / "Distribution.xml").write_text(distribution_xml(info["CFBundleVersion"], development))
        args = ["productbuild", "--distribution", str(temp / "Distribution.xml"), "--resources", str(resources),
                "--package-path", str(temp)]
        if not development:
            args += ["--sign", installer_identity]
        candidate = temp / "candidate.pkg"
        run(*args, str(candidate))
        if not development:
            signature = run("pkgutil", "--check-signature", str(candidate)).stdout.decode()
            if not re.search(r"Developer ID Installer: .+ \(" + re.escape(team_id) + r"\)", signature):
                raise ValueError("The produced package does not have the specified Developer ID Installer signature.")
        run("pkgutil", "--expand-full", str(candidate), str(temp / "expanded"))
        expanded_app = validate_expanded_package(temp / "expanded", expected_app_hash)
        validate_signed_app(expanded_app, team_id)
        candidate_bytes = candidate.read_bytes()
        # Exclusive creation: never replace a reviewed candidate or follow a link.
        with output.open("xb") as handle:
            handle.write(candidate_bytes)
        report = {"artifact": name, "sha256": hashlib.sha256(candidate_bytes).hexdigest(),
                  "bundleID": BUNDLE_ID, "version": info["CFBundleVersion"], "architectures": ["arm64"],
                  "minimumOS": "27.0", "installationLocation": "/Applications", "installerScripts": False,
                  "copiesAppOnly": True, "signature": "unsigned development" if development else "Developer ID candidate",
                  "notarized": False, "runtimeVerified": False, "releaseReady": False,
                  "installed": False, "launched": False, "autostartEnabled": False}
        with manifest.open("x") as handle:
            handle.write(json.dumps(report, indent=2) + "\n")
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["development", "release-candidate"])
    parser.add_argument("--app", type=Path)
    parser.add_argument("--team-id")
    parser.add_argument("--installer-identity")
    args = parser.parse_args()
    try:
        output = build_package(args.mode, args.app, args.team_id, args.installer_identity)
    except (ValueError, OSError, subprocess.CalledProcessError, zipfile.BadZipFile, plistlib.InvalidFileException) as error:
        # Do not print subprocess streams, source bundle contents or private paths.
        detail = str(error) if isinstance(error, ValueError) else "Packaging tool or input validation failed."
        parser.exit(1, detail + " No app was installed or launched.\n")
    print(f"Prepared {output.name}; not installed, launched, notarized or ready for distribution.")


if __name__ == "__main__":
    main()
