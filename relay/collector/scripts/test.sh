#!/bin/zsh -f
# Pure fixture executable: AppMain and App Sandbox app entry point are excluded.
set -euo pipefail
HERE="${0:A:h:h}"
TEMP_TEST="$(mktemp -d "${TMPDIR:-/tmp}/alfred-collector-tests.XXXXXX")"
trap 'rm -rf "$TEMP_TEST"' EXIT
swiftc -parse-as-library -module-cache-path "$TEMP_TEST/module-cache" \
  "$HERE/Sources/Core.swift" "$HERE/Sources/MessageSource.swift" "$HERE/Sources/Transport.swift" \
  "$HERE/tests/CollectorTests.swift" "$HERE/tests/ReceiptTests.swift" "$HERE/tests/CursorTests.swift" -o "$TEMP_TEST/collector-tests"
"$TEMP_TEST/collector-tests"
swiftc -parse-as-library -module-cache-path "$TEMP_TEST/module-cache" \
  "$HERE/Sources/Core.swift" "$HERE/Sources/AccountIdentity.swift" \
  "$HERE/tests/AccountIdentityTests.swift" -o "$TEMP_TEST/account-identity-tests"
"$TEMP_TEST/account-identity-tests"
swiftc -parse-as-library -module-cache-path "$TEMP_TEST/module-cache" \
  "$HERE/Sources/Core.swift" "$HERE/Sources/AccountIdentity.swift" "$HERE/Sources/CollectorHealth.swift" \
  "$HERE/tests/CollectorHealthTests.swift" -o "$TEMP_TEST/collector-health-tests"
"$TEMP_TEST/collector-health-tests"
python3 "$HERE/tests/PolicyTests.py"
zsh -n "$HERE/scripts/build.sh" "$HERE/scripts/test.sh"
