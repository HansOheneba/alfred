#!/usr/bin/env python3
"""Synthetic installer contracts; never execute the installer or installed relay.

Run from repository root: python3 relay/mac/tests/InstallerTests.py
All file I/O targets TemporaryDirectory fixtures. Launchctl is always mocked.
"""
from __future__ import annotations

import ast
import contextlib
from dataclasses import dataclass
import hashlib
import io
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


INSTALLER = Path(__file__).resolve().parents[1] / "install.sh"
LABEL = "com.fixture.alfred-relay"
FIXTURE_KEY = "alf_SYNTHETIC_FIXTURE_NOT_A_REAL_KEY"
PRIVATE_MARKER = "SYNTHETIC_PRIVATE_VALUE_MUST_NOT_ESCAPE"


@dataclass
class Result:
    code: int
    stdout: str
    stderr: str
    error: type[BaseException] | None = None


class InstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = INSTALLER.read_text(encoding="utf-8")
        heredocs = re.findall(r"<<'PY'\n(.*?)\nPY", cls.source, re.S)
        private = re.findall(r"python3 -c '\n(.*?)\n' ", cls.source, re.S)
        cls.all_python = heredocs + private

        def select(marker: str, candidates: list[str] = heredocs) -> str:
            matches = [block for block in candidates if marker in block]
            if len(matches) != 1:
                raise AssertionError("Cannot uniquely locate installer Python contract: " + marker)
            return matches[0]

        cls.metadata = select("subprocess.run")
        cls.manifest = select("Safe relay binary/LaunchAgent manifest")
        cls.config = select("Config missing, invalid, unsupported")
        cls.stage = select("plistlib.dump(agent")
        cls.writer = select("key = sys.stdin.read()", private)
        for block in cls.all_python:
            ast.parse(block)

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="alfred-installer-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.root.chmod(0o700)
        self.home = self.root / "fake home & <fixture>"
        self.support = self.home / "Library/Application Support/AlfredRelay"
        self.stage_dir = self.root / "stage"
        self.stage_dir.mkdir(mode=0o700)
        self.binary = self.stage_dir / "alfred-relay"
        self.binary.write_bytes(b"synthetic fixture only; never executable")
        self.binary.chmod(0o600)
        self.agent = self.stage_dir / (LABEL + ".plist")
        self.manifest_file = self.stage_dir / "interface.json"
        self.config_file = self.root / "synthetic-config.json"

    def run_block(self, block: str, args: list[object], stdin: str = "") -> Result:
        output, errors = io.StringIO(), io.StringIO()
        code, error = 0, None
        # Both argv paths and Path.home() refer only to this test's fake home.
        with mock.patch.object(sys, "argv", ["synthetic-fixture", *map(str, args)]), \
             mock.patch.object(sys, "stdin", io.StringIO(stdin)), \
             mock.patch("pathlib.Path.home", return_value=self.home), \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            try:
                exec(compile(block, "<synthetic-installer-contract>", "exec"), {"__name__": "__main__"})
            except SystemExit as exit_result:
                code = exit_result.code
            except Exception as failure:
                code, error = 1, type(failure)
        return Result(code, output.getvalue(), errors.getvalue(), error)

    def prepare_fixture(self) -> None:
        watched = self.home / "Library/Messages/chat.db-wal"
        result = self.run_block(self.stage, [self.support, watched, LABEL, self.stage_dir])
        self.assertEqual(result.code, 0)
        self.assertIsNone(result.error)
        for path in self.stage_dir.iterdir():
            path.chmod(0o600)

    def verify_fixture(self) -> Result:
        return self.run_block(self.manifest, [self.stage_dir, self.support, LABEL])

    def rewrite_manifest(self, **updates: object) -> None:
        value = json.loads(self.manifest_file.read_text())
        value.update(updates)
        self.manifest_file.write_text(json.dumps(value))

    def write_config(self, **updates: object) -> None:
        value = {"version": 1, "key": FIXTURE_KEY, "senderAllowlist": ["mobilemoney", "absa"]}
        value.update(updates)
        self.config_file.write_text(json.dumps(value))
        self.config_file.chmod(0o600)

    def test_embedded_python_is_syntax_valid(self) -> None:
        self.assertGreaterEqual(len(self.all_python), 5)
        for block in self.all_python:
            with self.subTest(contract=ast.parse(block).body[0].__class__.__name__):
                ast.parse(block)

    def test_default_and_help_have_no_live_operations(self) -> None:
        self.assertIn('action="${1:---help}"', self.source)
        help_branch = self.source.split('  --help|-h)', 1)[1].split('  --prepare)', 1)[0]
        self.assertIn("usage", help_branch)
        for forbidden in ("launchctl", '"$BIN"', "read -", "swiftc", "mkdir", "install -", "python3"):
            self.assertNotIn(forbidden, help_branch)

    def test_prepare_branch_does_not_start_install_or_read_messages(self) -> None:
        prepare = self.source.split('  --prepare)', 1)[1].split('  --install)', 1)[0]
        for forbidden in ("launchctl", '"$BIN" --', "safe_support", "validate_config", "read -rs", "--initialize"):
            self.assertNotIn(forbidden, prepare)
        self.assertIn('-module-cache-path "$BUILD_DIR/module-cache"', prepare)

    def test_enable_preflights_before_baseline_initialization(self) -> None:
        enable = self.source.split('  --enable)', 1)[1].split('  --status)', 1)[0]
        initialize = enable.index('"$BIN" --initialize')
        for prerequisite in ('verify_build "$SUPPORT"', "validate_config", "last-rowid", 'cmp -s "$INSTALLED_AGENT" "$AGENT"', 'PENDING_AGENT="$(mktemp'):
            self.assertLess(enable.index(prerequisite), initialize)
        self.assertLess(enable.index('"$BIN" --status'), enable.index("launchctl bootstrap"))

    def test_private_input_clears_inherited_export(self) -> None:
        configure = self.source.split('  --configure)', 1)[1].split('  --enable)', 1)[0]
        self.assertIn("unsetopt xtrace verbose allexport", self.source)
        self.assertLess(configure.index("unset KEY"), configure.index("read -rs KEY"))
        self.assertLess(configure.index("typeset KEY"), configure.index("read -rs KEY"))
        self.assertIn('print -rn -- "$KEY" | python3 -c', configure)

    def test_stage_is_disabled_and_escapes_paths(self) -> None:
        self.prepare_fixture()
        with self.agent.open("rb") as source:
            definition = plistlib.load(source)
        self.assertIs(definition["Disabled"], True)
        self.assertEqual(definition["Label"], LABEL)
        self.assertEqual(definition["ProgramArguments"], [str(self.support / "alfred-relay")])
        self.assertEqual(definition["WatchPaths"], [str(self.home / "Library/Messages/chat.db-wal")])
        self.assertEqual(definition["StartInterval"], 120)
        self.assertEqual(definition["ThrottleInterval"], 10)
        example = json.loads((self.stage_dir / "config.example.json").read_text())
        self.assertEqual(example, {"version": 1, "key": "", "senderAllowlist": []})
        self.assertFalse((self.home / "Library/LaunchAgents").exists())

    def test_valid_manifest_accepts_only_fixture_files(self) -> None:
        self.prepare_fixture()
        self.assertEqual(self.verify_fixture().code, 0)

    def test_missing_manifest_rejects_legacy_fixture(self) -> None:
        self.assertNotEqual(self.verify_fixture().code, 0)

    def test_changed_binary_rejects(self) -> None:
        self.prepare_fixture()
        self.binary.write_bytes(b"changed nonexecutable fixture")
        self.assertNotEqual(self.verify_fixture().code, 0)

    def test_changed_plist_rejects(self) -> None:
        self.prepare_fixture()
        self.agent.write_bytes(self.agent.read_bytes() + b"\n")
        self.assertNotEqual(self.verify_fixture().code, 0)

    def test_rehashed_wrong_program_still_rejects(self) -> None:
        self.prepare_fixture()
        with self.agent.open("rb") as source:
            definition = plistlib.load(source)
        definition["ProgramArguments"] = [str(self.root / "unapproved-program")]
        with self.agent.open("wb") as target:
            plistlib.dump(definition, target)
        self.rewrite_manifest(agentSHA256=hashlib.sha256(self.agent.read_bytes()).hexdigest())
        self.assertNotEqual(self.verify_fixture().code, 0)

    def test_boolean_manifest_version_rejects(self) -> None:
        self.prepare_fixture()
        self.rewrite_manifest(interfaceVersion=True)
        self.assertNotEqual(self.verify_fixture().code, 0)

    def test_symlink_or_writable_manifest_rejects(self) -> None:
        for file_name in ("alfred-relay", "interface.json", LABEL + ".plist"):
            with self.subTest(file=file_name):
                self.prepare_fixture()
                path = self.stage_dir / file_name
                path.chmod(0o622)
                self.assertNotEqual(self.verify_fixture().code, 0)
                path.chmod(0o600)
                destination = self.root / ("synthetic-target-" + file_name)
                destination.write_bytes(path.read_bytes())
                path.unlink()
                path.symlink_to(destination)
                self.assertNotEqual(self.verify_fixture().code, 0)
                path.unlink()
                path.write_bytes(destination.read_bytes())
                path.chmod(0o600)

    def test_valid_private_config_accepts_without_output(self) -> None:
        self.write_config()
        result = self.run_block(self.config, [self.config_file])
        self.assertEqual(result.code, 0)
        self.assertEqual(result.stdout + result.stderr, "")

    def test_bad_config_rejects_without_values(self) -> None:
        cases = [
            {"version": 2}, {"version": True}, {"key": ""},
            {"senderAllowlist": []}, {"senderAllowlist": ["unknown-provider"]},
            {"senderAllowlist": ["absa", "absa"]}, {"senderAllowlist": "absa"},
        ]
        for updates in cases:
            with self.subTest(fields=tuple(updates)):
                self.write_config(**updates)
                result = self.run_block(self.config, [self.config_file])
                self.assertNotEqual(result.code, 0)
                self.assertNotIn(FIXTURE_KEY, result.stdout + result.stderr)
                self.assertIn("no values displayed", result.stderr)

    def test_public_or_symlink_config_rejects(self) -> None:
        self.write_config()
        self.config_file.chmod(0o644)
        self.assertNotEqual(self.run_block(self.config, [self.config_file]).code, 0)
        self.config_file.chmod(0o600)
        alias = self.root / "synthetic-config-link.json"
        alias.symlink_to(self.config_file)
        self.assertNotEqual(self.run_block(self.config, [alias]).code, 0)

    def test_private_writer_creates_exclusively_and_never_echoes(self) -> None:
        result = self.run_block(self.writer, [self.config_file, "mobilemoney"], FIXTURE_KEY)
        self.assertEqual(result.code, 0)
        self.assertEqual(stat.S_IMODE(self.config_file.stat().st_mode), 0o600)
        self.assertNotIn(FIXTURE_KEY, result.stdout + result.stderr)
        previous = self.config_file.read_bytes()
        result = self.run_block(self.writer, [self.config_file, "absa"], FIXTURE_KEY)
        self.assertIs(result.error, FileExistsError)
        self.assertEqual(self.config_file.read_bytes(), previous)

    def test_private_writer_invalid_input_creates_nothing(self) -> None:
        result = self.run_block(self.writer, [self.config_file, "mobilemoney"], PRIVATE_MARKER)
        self.assertNotEqual(result.code, 0)
        self.assertFalse(self.config_file.exists())
        self.assertNotIn(PRIVATE_MARKER, result.stdout + result.stderr)

    def test_launchd_metadata_redacts_simulated_environment(self) -> None:
        cases = [
            (f"\tstate = not running\n\truns = 5\n\tlast exit code = 0\n\tenvironment = {{ PRIVATE={PRIVATE_MARKER} }}", 0, 0, "not running"),
            ("\tstate = running\n\truns = 6\n\tlast exit code = 1", 0, 1, "running"),
            (f"\tstate = {PRIVATE_MARKER}\n\truns = 1", 0, 1, "unknown"),
            (PRIVATE_MARKER, 113, 1, "unknown"),
        ]
        for raw, returncode, expected_code, expected_state in cases:
            with self.subTest(returncode=returncode, expected=expected_code, state=expected_state):
                fake = SimpleNamespace(stdout=raw, stderr=PRIVATE_MARKER, returncode=returncode)
                with mock.patch("subprocess.run", return_value=fake) as launchctl:
                    result = self.run_block(self.metadata, [LABEL])
                launchctl.assert_called_once()
                self.assertEqual(launchctl.call_args.args[0], ["launchctl", "print", f"gui/{os.getuid()}/{LABEL}"])
                self.assertTrue(launchctl.call_args.kwargs["capture_output"])
                self.assertEqual(result.code, expected_code)
                self.assertNotIn(PRIVATE_MARKER, result.stdout + result.stderr)
                value = json.loads(result.stdout)
                self.assertEqual(set(value), {"launchAgentLoaded", "state", "runs", "lastExitCode"})
                self.assertEqual(value["state"], expected_state)

    def test_status_has_failure_exit_and_manifest_gate(self) -> None:
        status = self.source.split('  --status)', 1)[1].split('  --disable)', 1)[0]
        self.assertIn('exit "$STATUS_EXIT"', status)
        self.assertIn("STATUS_EXIT=1", status)
        self.assertLess(status.index('verify_build "$SUPPORT"'), status.index('"$BIN" --status'))
        self.assertIn("if ! service_metadata", status)


if __name__ == "__main__":
    unittest.main(verbosity=2)
