"""Synthetic archives and package metadata only; never run or install the app."""
import importlib.util
from pathlib import Path
import plistlib
import stat
import tempfile
import unittest
import zipfile
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("packaging", ROOT / "scripts/packaging.py")
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="alfred-packaging-fixture-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def app(self, root=None):
        app = (root or self.root) / packaging.APP_NAME
        (app / "Contents/MacOS").mkdir(parents=True)
        (app / "Contents/Info.plist").write_bytes((ROOT / "Info.plist").read_bytes())
        (app / "Contents/MacOS/AlfredCollector").write_bytes(b"synthetic-not-an-executable")
        agent = app / packaging.AGENT_RELATIVE_PATH
        agent.parent.mkdir(parents=True)
        agent.write_bytes((ROOT / packaging.AGENT_NAME).read_bytes())
        return app

    def archive(self, names):
        archive = self.root / "input.zip"
        with zipfile.ZipFile(archive, "w") as output:
            for name, mode, data in names:
                entry = zipfile.ZipInfo(name)
                entry.external_attr = mode << 16
                output.writestr(entry, data)
        return archive

    def test_extracts_only_one_bounded_app_and_preserves_executable_mode(self):
        archive = self.archive([(packaging.APP_NAME + "/Contents/MacOS/AlfredCollector", stat.S_IFREG | 0o755, b"fixture")])
        app = packaging.extract_development_archive(archive, self.root / "output")
        binary = app / "Contents/MacOS/AlfredCollector"
        self.assertEqual(binary.read_bytes(), b"fixture")
        self.assertEqual(stat.S_IMODE(binary.stat().st_mode), 0o755)

    def test_rejects_traversal_other_roots_backslashes_links_and_special_files(self):
        cases = [("../escape", stat.S_IFREG), ("/tmp/escape", stat.S_IFREG),
                 ("Other.app/Contents/file", stat.S_IFREG),
                 (packaging.APP_NAME + "/../escape", stat.S_IFREG),
                 (packaging.APP_NAME + "/Contents\\escape", stat.S_IFREG),
                 (packaging.APP_NAME + "/Contents//escape", stat.S_IFREG),
                 (packaging.APP_NAME + "/Contents/./escape", stat.S_IFREG),
                 (packaging.APP_NAME + "/Contents/link", stat.S_IFLNK),
                 (packaging.APP_NAME + "/Contents/pipe", stat.S_IFIFO)]
        for name, mode in cases:
            with self.subTest(name=name):
                archive = self.archive([(name, mode | 0o600, b"fixture")])
                with self.assertRaises(ValueError):
                    packaging.extract_development_archive(archive, self.root / "output")

    def test_duplicate_or_oversized_archive_is_rejected(self):
        name = packaging.APP_NAME + "/Contents/file"
        with self.assertWarns(UserWarning):
            archive = self.archive([(name, stat.S_IFREG | 0o600, b"a"), (name, stat.S_IFREG | 0o600, b"b")])
        with self.assertRaises(ValueError):
            packaging.extract_development_archive(archive, self.root / "duplicates")
        archive = self.archive([(name, stat.S_IFREG | 0o600, b"a"), (name.upper(), stat.S_IFREG | 0o600, b"b")])
        with self.assertRaises(ValueError):
            packaging.extract_development_archive(archive, self.root / "case-duplicates")
        archive = self.archive([(name, stat.S_IFREG | 0o600, b"123")])
        previous = packaging.MAX_ARCHIVE_BYTES
        try:
            packaging.MAX_ARCHIVE_BYTES = 2
            with self.assertRaises(ValueError):
                packaging.extract_development_archive(archive, self.root / "oversize")
        finally:
            packaging.MAX_ARCHIVE_BYTES = previous

    def test_exact_identity_platform_and_safe_version(self):
        app = self.app()
        self.assertEqual(packaging.validate_layout(app)["CFBundleIdentifier"], packaging.BUNDLE_ID)
        for key, value in [("CFBundleIdentifier", "other"), ("CFBundleName", "Other Sync"),
                           ("CFBundleDisplayName", "Other Sync"), ("LSMinimumSystemVersion", "13.0"),
                           ("CFBundleExecutable", "other"), ("CFBundleVersion", "1;unsafe")]:
            info = plistlib.loads((ROOT / "Info.plist").read_bytes())
            info[key] = value
            (app / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
            with self.subTest(key=key), self.assertRaises(ValueError):
                packaging.validate_layout(app)

    def test_bundled_background_service_has_only_fixed_reviewed_scope(self):
        app = self.app()
        agent_path = app / packaging.AGENT_RELATIVE_PATH
        packaging.validate_bundled_agent(app)
        self.assertEqual(plistlib.loads(agent_path.read_bytes()), packaging.EXPECTED_AGENT)
        for key, value in [("Label", "com.someone.else"), ("BundleProgram", "/tmp/other"),
                           ("ProgramArguments", ["AlfredCollector", "--run"]),
                           ("StartInterval", 120), ("RunAtLoad", 1),
                           ("StandardOutPath", "/tmp/collector.log"),
                           ("KeepAlive", True), ("EnvironmentVariables", {"KEY": "fixture"})]:
            agent = dict(packaging.EXPECTED_AGENT)
            agent[key] = value
            agent_path.write_bytes(plistlib.dumps(agent))
            with self.subTest(key=key), self.assertRaises(ValueError):
                packaging.validate_bundled_agent(app)

    def test_candidate_keeps_stable_storage_identity_and_version_advances(self):
        info = plistlib.loads((ROOT / "Info.plist").read_bytes())
        self.assertEqual(info["CFBundleIdentifier"], "com.hansopoku.alfred.collector")
        self.assertEqual(info["CFBundleExecutable"], "AlfredCollector")
        self.assertEqual(info["CFBundleVersion"], "2")
        self.assertEqual(info["CFBundleName"], "Alfred Sync")

    def test_private_or_unreviewed_resources_are_not_packaged(self):
        app = self.app()
        for name in ["config.json", "account.json", "outbox.sqlite", ".env", "unknown.pem"]:
            resource = app / "Contents" / name
            resource.write_text("synthetic-private-fixture")
            with self.subTest(name=name), self.assertRaises(ValueError):
                packaging.validate_layout(app)
            resource.unlink()
        link = app / "Contents/link"
        link.symlink_to("Info.plist")
        with self.assertRaises(ValueError):
            packaging.validate_layout(app)

    def test_bundle_copy_retains_bytes_with_safe_modes_and_does_not_change_source(self):
        source = self.app()
        binary = source / "Contents/MacOS/AlfredCollector"
        binary.chmod(0o777)
        destination = self.root / "copy" / packaging.APP_NAME
        destination.parent.mkdir()
        packaging.copy_bundle(source, destination)
        copied = destination / "Contents/MacOS/AlfredCollector"
        self.assertEqual(copied.read_bytes(), binary.read_bytes())
        self.assertEqual(stat.S_IMODE(copied.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(binary.stat().st_mode), 0o777)
        self.assertEqual(stat.S_IMODE((destination / "Contents/Info.plist").stat().st_mode), 0o644)

    def test_installer_does_not_run_scripts_or_offer_unsupported_platforms(self):
        for development in [True, False]:
            distribution = ET.fromstring(packaging.distribution_xml("1", development))
            self.assertEqual(distribution.find("options").attrib,
                             {"customize": "never", "require-scripts": "false", "hostArchitectures": "arm64"})
            self.assertEqual(distribution.find("allowed-os-versions/os-version").get("min"), "27.0")
            self.assertEqual(distribution.find("pkg-ref").get("onConclusion"), "none")
            self.assertEqual(distribution.find("domains").get("enable_currentUserHome"), "false")
            self.assertIsNone(distribution.find("installation-check"))

    def test_expanded_payload_contains_only_app_and_no_installer_scripts(self):
        component = self.root / "expanded/collector.pkg"
        component.mkdir(parents=True)
        (component / "PackageInfo").write_text(
            '<pkg-info identifier="' + packaging.BUNDLE_ID + '.installer" install-location="/Applications"/>')
        payload = component / "Payload"
        payload.mkdir()
        self.app(payload)
        packaging.validate_expanded_package(self.root / "expanded")
        (component / "Scripts").mkdir()
        with self.assertRaises(ValueError):
            packaging.validate_expanded_package(self.root / "expanded")

    def test_expanded_payload_must_match_exact_reviewed_app_bytes_and_tree(self):
        component = self.root / "expanded/collector.pkg"
        component.mkdir(parents=True)
        (component / "PackageInfo").write_text(
            '<pkg-info identifier="' + packaging.BUNDLE_ID + '.installer" install-location="/Applications"/>')
        payload = component / "Payload"
        payload.mkdir()
        app = self.app(payload)
        expected_hash = packaging.bundle_tree_hash(app)
        self.assertEqual(packaging.validate_expanded_package(self.root / "expanded", expected_hash), app)
        binary = app / "Contents/MacOS/AlfredCollector"
        binary.write_bytes(b"changed-after-signature-validation")
        with self.assertRaises(ValueError):
            packaging.validate_expanded_package(self.root / "expanded", expected_hash)
        binary.write_bytes(b"synthetic-not-an-executable")
        (app / "Contents/UnexpectedEmptyDirectory").mkdir()
        with self.assertRaises(ValueError):
            packaging.validate_expanded_package(self.root / "expanded", expected_hash)

    def test_development_mode_cannot_use_signing_identity_and_release_fails_closed(self):
        for mode, app, team, identity in [("development", None, "ABCDE12345", None),
                                         ("release-candidate", None, None, None),
                                         ("release-candidate", self.root, "ABCDE12345", "other")]:
            with self.assertRaises(ValueError):
                packaging.build_package(mode, app, team, identity)

    def test_packaging_never_installs_or_changes_runtime_access(self):
        source = (ROOT / "scripts/packaging.py").read_text()
        for command in ['run("installer"', 'run("launchctl"', 'run("open"', 'run("tccutil"',
                        'run("xattr"', 'run("notarytool"', 'run("security"']:
            self.assertNotIn(command, source)
        self.assertNotIn("--scripts", source)
        self.assertIn('"releaseReady": False', source)


if __name__ == "__main__":
    unittest.main(verbosity=1)
