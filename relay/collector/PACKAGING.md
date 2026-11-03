# Mac installer preparation

The copy-only installer is implemented and can be inspected without installing
or opening the app. **The current development package is not a distributable
release.** It has no Developer ID installer signature or notarization, and real
Messages access is still unverified. Packaging cannot fix a denied sandbox or
grant Full Disk Access. Never disable Gatekeeper, strip quarantine attributes,
broaden file entitlements, or substitute a different launcher to bypass a denial.

The current binary and installer support **Apple Silicon and macOS 27 or later**.
An older minimum OS in a plist would not lower the actual compiled requirement.
Intel/older macOS builds need their own reviewed implementation and runtime
verification. They are not offered by this installer.

## Local preparation

From `relay/collector`:

```sh
./scripts/test.sh
./scripts/build.sh
python3 scripts/packaging.py development
```

This produces ignored development artifacts in `build/`. The installer contains
only `Alfred Collector.app`, copied to `/Applications`. Its package metadata and
payload are expanded and checked after creation. There are **no installer
scripts**, LaunchAgent installation, app launches, login registration, account
configuration, permission requests, Messages queries, secret entry, or network
delivery. The disabled LaunchAgent file is an inert resource inside the app.
Preparing the package does not install it. Do not distribute the development
package or direct users to open an unsigned package as a workaround.

The JSON package manifest records the exact artifact hash, architecture,
minimum OS, destination, and explicit `releaseReady: false`, `runtimeVerified:
false`, `installed: false`, and `autostartEnabled: false`. An existing artifact is
never silently replaced. Remove only the previous ignored build artifact after
review if another package is needed; do not delete private collector state.

## Release gates

A release owner must complete and record these steps before general use:

1. Review the final source and native tests. Increment `CFBundleVersion` for
   each released build; the installer checks bundle versions and never relocates
   an app with the same bundle ID from another folder. This is a manually
   reviewed update flow, not an automatic updater.
2. Establish runtime Messages DB/WAL/SHM access for the exact signed app and
   reviewed account/provider scope on the supported OS. Build/signature checks
   do not establish this. A denial is a blocker, not permission to broaden access.
3. Use the intended Apple developer team's **Developer ID Application** identity
   to sign the app with the existing exact entitlements, Hardened Runtime and a
   secure timestamp. Verify the signature. No signing identity or credential is
   selected, created, or used by the local preparation above.
4. After separate upload approval, notarize the signed app archive with Apple's
   `notarytool`, using an already approved secure credential profile. Review the
   result, staple the accepted ticket to the app and validate it. Do not place an
   Apple password, API key, or other secret in a command, repository, or chat.
5. Prepare a signed installer candidate from that app, selecting the exact team
   and **Developer ID Installer** identity. The guarded path is:

   ```sh
   python3 scripts/packaging.py release-candidate \
     --app '/approved/staging/Alfred Collector.app' \
     --team-id 'TEAMID1234' \
     --installer-identity 'Developer ID Installer: Approved Team (TEAMID1234)'
   ```

   These values are placeholders for public signing identities, not credentials.
   This command is an explicit signing operation and was **not executed** during
   local preparation. It fails closed for ad-hoc apps, a wrong team, missing
   Hardened Runtime/timestamp, altered sandbox scope, private state, extra
   resources, unsupported binary requirements, or a changed package payload.
   It does not notarize, install, launch, or call a credential-creation tool.
6. After separate upload approval, notarize the resulting package, inspect the
   accepted result, staple and validate its ticket, and assess it with Gatekeeper
   on a supported clean Mac. Verify the final installer signature and publish a
   new checksum after stapling, since stapling changes the artifact. The candidate
   manifest deliberately remains **not release-ready**; notarization and runtime
   evidence must accompany any final release record. A signed candidate alone
   must never be presented as a finished release.
7. Test installation, update and removal on a disposable supported Mac. Confirm
   the installer only copies the app, collection stays off until explicit setup,
   and an update retains pending alerts and the original future-only baseline.
   These installation/runtime checks remain unrun in this workspace.

The release process follows Apple's [packaging guidance](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)
and [notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
Notarization checks the submitted software; it does not grant Messages access
or prove correct finance delivery.

## Updates and removal

Before updating or removing an activated collector, pause its explicitly
installed background schedule through the approved service-management flow and
quit the app. The installer has no script that stops a running process and must
not race a running collector. Do not install over an active collector as a way
to reset or repair it.

For an update, install the reviewed newer app at the same `/Applications`
location. The copy-only installer never targets the app's private container,
configuration, account binding, outbox, baseline, or Messages database. Do not
reset those files when an update cannot read a stored version; retain the data
and resolve the compatibility issue.

For removal, first disable the installed schedule and then move only the app
from Applications to Trash. Keep the private collector container by default:
it may hold alerts that Alfred has not acknowledged. Deleting that data is a
separate explicit decision after reviewing pending alerts and account state.
No uninstall script, credential deletion or receipt-forgetting command is run
by this packaging workflow.
