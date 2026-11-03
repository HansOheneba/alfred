#!/bin/zsh
# Build/run synthetic tests only. Never invokes the relay runtime or installer.
set -euo pipefail
HERE="${0:A:h}"
BUILD="$(mktemp -d "${TMPDIR:-/tmp}/alfred-relay-tests.XXXXXX")"
trap 'rm -rf "$BUILD"' EXIT
{ print -r -- 'let sandboxProfile = #"""'; cat "$HERE/sandbox.sb"; print -r -- '"""#'; } > "$BUILD/Profile.swift"
# Exclude production top-level entry point and build the fixture @main instead.
sed '/^#if !RELAY_TEST$/,$d' "$HERE/AlfredRelay.swift" > "$BUILD/RelayLibrary.swift"
swiftc -D RELAY_TEST -parse-as-library -module-cache-path "$BUILD/module-cache" \
  "$BUILD/RelayLibrary.swift" "$BUILD/Profile.swift" "$HERE/tests/RelayTests.swift" -o "$BUILD/relay-tests"
"$BUILD/relay-tests"
python3 "$HERE/tests/InstallerTests.py" -q
zsh -n "$HERE/install.sh"
swiftc -D RELAY_TEST -parse-as-library -module-cache-path "$BUILD/module-cache" \
  "$BUILD/RelayLibrary.swift" "$BUILD/Profile.swift" "$HERE/tests/SandboxTests.swift" -o "$BUILD/sandbox-tests"
# Optional, isolated synthetic HOME probe. Restricted execution environments
# may prohibit applying another sandbox. Never retry by weakening restrictions.
if [[ "${ALFRED_TEST_SANDBOX:-0}" == 1 ]]; then
  set +e
  "$BUILD/sandbox-tests" "$BUILD/synthetic-home"
  SANDBOX_RESULT=$?
  set -e
  [[ "$SANDBOX_RESULT" == 0 || "$SANDBOX_RESULT" == 77 ]] || exit "$SANDBOX_RESULT"
else
  print -r -- 'SKIP: sandbox runtime probe not requested; compiled but compatibility remains unverified.'
fi
# Compile the production entry point as well, without executing it.
cp "$HERE/AlfredRelay.swift" "$BUILD/main.swift"
swiftc -O -module-cache-path "$BUILD/module-cache" "$BUILD/main.swift" "$BUILD/Profile.swift" -o "$BUILD/alfred-relay"
print -r -- 'PASS: production relay compiled; executable was not run.'
