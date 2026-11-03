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
swiftc -parse-as-library -module-cache-path "$TEMP_TEST/module-cache" \
  "$HERE/Sources/Core.swift" "$HERE/Sources/AccountIdentity.swift" "$HERE/Sources/HeldReview.swift" \
  "$HERE/tests/HeldReviewTests.swift" -o "$TEMP_TEST/held-review-tests"
"$TEMP_TEST/held-review-tests"
swiftc -parse-as-library -module-cache-path "$TEMP_TEST/module-cache" \
  "$HERE/Sources/Core.swift" "$HERE/Sources/AccountIdentity.swift" "$HERE/Sources/CollectorHealth.swift" \
  "$HERE/Sources/CollectorSetup.swift" "$HERE/Sources/MessageSource.swift" "$HERE/Sources/Transport.swift" \
  "$HERE/tests/CollectorSetupTests.swift" -o "$TEMP_TEST/collector-setup-tests"
"$TEMP_TEST/collector-setup-tests"
python3 "$HERE/tests/PolicyTests.py"
python3 -B "$HERE/packaging-tests/test_packaging.py"
zsh -n "$HERE/scripts/build.sh" "$HERE/scripts/test.sh"
