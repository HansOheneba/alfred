#!/bin/zsh -f
# Build/sign/stage ONLY. Never run, install, register or configure the app.
set -euo pipefail
umask 077
HERE="${0:A:h:h}"
STAGE="$HERE/build"
[[ ! -L "$STAGE" ]] || { print -u2 'Refusing symlinked build directory.'; exit 1; }
mkdir -p "$STAGE"
# The workspace is FileProvider-backed and adds FinderInfo to .app directories,
# which codesign rejects. Build in a normal temporary directory and stage a ZIP;
# do not strip quarantine/security attributes or run the generated application.
TEMP_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/alfred-collector-build.XXXXXX")"
trap 'rm -rf "$TEMP_BUILD"' EXIT
APP="$TEMP_BUILD/Alfred Sync.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Library/LaunchAgents"
# Copy source bytes into new resources, rather than copying resource forks or
# Finder/compression metadata. Original files/security attributes are untouched.
python3 - "$HERE" "$APP" <<'PY'
import pathlib,sys
source,app=map(pathlib.Path,sys.argv[1:])
(app/'Contents/Info.plist').write_bytes((source/'Info.plist').read_bytes())
(app/'Contents/Resources/README.md').write_bytes((source/'README.md').read_bytes())
(app/'Contents/Library/LaunchAgents/com.hansopoku.alfred.collector.agent.plist').write_bytes((source/'com.hansopoku.alfred.collector.agent.plist').read_bytes())
PY
swiftc -O -parse-as-library -module-cache-path "$TEMP_BUILD/module-cache" \
  "$HERE/Sources/Core.swift" "$HERE/Sources/MessageSource.swift" "$HERE/Sources/Transport.swift" "$HERE/Sources/AccountIdentity.swift" "$HERE/Sources/CollectorHealth.swift" "$HERE/Sources/HeldReview.swift" "$HERE/Sources/HeldReviewWindow.swift" "$HERE/Sources/CollectorSetup.swift" "$HERE/Sources/CollectorSetupWindow.swift" "$HERE/Sources/AppMain.swift" \
  -o "$APP/Contents/MacOS/AlfredCollector"
if ! codesign --force --sign - --entitlements "$HERE/Collector.entitlements" "$APP"; then
  # Diagnostic names only; no resource values, source contents or credentials.
  python3 - "$APP" <<'PY'
import json,pathlib,subprocess,sys
app=pathlib.Path(sys.argv[1])
for path in [app,*app.rglob('*')]:
    result=subprocess.run(['xattr',str(path)],capture_output=True,text=True)
    if result.stdout.strip(): print(json.dumps({'generated_path':str(path.relative_to(app)),'xattr_names':result.stdout.splitlines()}))
PY
  exit 1
fi
codesign --verify --strict "$APP"
python3 - "$APP" "$STAGE" <<'PY'
import hashlib,json,pathlib,plistlib,re,subprocess,sys,tempfile,zipfile
app,stage=map(pathlib.Path,sys.argv[1:])
result=subprocess.run(['codesign','-d','--entitlements',':-',str(app)],capture_output=True,check=True)
ent=plistlib.loads(result.stdout)
expected={'com.apple.security.app-sandbox':True,'com.apple.security.network.client':True,'com.apple.security.temporary-exception.files.home-relative-path.read-only':['/Library/Messages/chat.db','/Library/Messages/chat.db-wal','/Library/Messages/chat.db-shm']}
if ent!=expected or type(ent.get('com.apple.security.app-sandbox')) is not bool or type(ent.get('com.apple.security.network.client')) is not bool: raise SystemExit('Staged signature entitlement scope mismatch; app was not executed.')
binary=app/'Contents/MacOS/AlfredCollector'
info=plistlib.loads((app/'Contents/Info.plist').read_bytes())
architectures=subprocess.run(['lipo','-archs',str(binary)],capture_output=True,text=True,check=True).stdout.split()
build_metadata=subprocess.run(['vtool','-show-build',str(binary)],capture_output=True,text=True,check=True).stdout
minimum_os_versions=sorted(set(re.findall(r'^\s*minos\s+(\S+)\s*$',build_metadata,re.M)))
sdk_versions=sorted(set(re.findall(r'^\s*sdk\s+(\S+)\s*$',build_metadata,re.M)))
platforms=re.findall(r'^\s*platform\s+(\S+)\s*$',build_metadata,re.M)
declared_minimum=info['LSMinimumSystemVersion']
version=lambda value:tuple(map(int,value.split('.')))
if not architectures or not minimum_os_versions or not sdk_versions or not platforms or any(p!='MACOS' for p in platforms): raise SystemExit('Cannot establish actual build compatibility; no app executed.')
if any(version(value)>version(declared_minimum) for value in minimum_os_versions): raise SystemExit('Declared minimum macOS understates the actual binary requirement; no app executed.')
agent=plistlib.loads((app/'Contents/Library/LaunchAgents/com.hansopoku.alfred.collector.agent.plist').read_bytes())
expected_agent={'Label':'com.hansopoku.alfred.collector.agent','BundleProgram':'Contents/MacOS/AlfredCollector','ProgramArguments':['AlfredCollector','--scheduled-run'],'RunAtLoad':True,'StartInterval':60,'ProcessType':'Background'}
if agent!=expected_agent or type(agent.get('RunAtLoad')) is not bool or type(agent.get('StartInterval')) is not int: raise SystemExit('Bundled service scope differs from the reviewed plan; no app executed.')
archive=stage/'Alfred Sync.app.zip'
temporary=stage/'.Alfred Sync.app.zip.tmp'
with zipfile.ZipFile(temporary,'w',compression=zipfile.ZIP_DEFLATED) as output:
    output.write(app,app.name+'/')
    for path in sorted(app.rglob('*')): output.write(path,str(path.relative_to(app.parent)))
# Verify a restored copy's signature, without executing it or changing grants.
with tempfile.TemporaryDirectory(prefix='archive-check-',dir=app.parent) as target:
    subprocess.run(['ditto','-x','-k',str(temporary),target],check=True)
    subprocess.run(['codesign','--verify','--strict',str(pathlib.Path(target)/app.name)],check=True)
temporary.replace(archive)
manifest={'bundleID':'com.hansopoku.alfred.collector','displayName':'Alfred Sync','bundleVersion':info['CFBundleVersion'],'binarySHA256':hashlib.sha256(binary.read_bytes()).hexdigest(),'archiveSHA256':hashlib.sha256(archive.read_bytes()).hexdigest(),'artifact':archive.name,'appSandboxDeclared':True,'signature':'ad-hoc local development only','signatureVerified':True,'architectures':architectures,'actualMinimumOSVersions':minimum_os_versions,'sdkVersions':sdk_versions,'declaredMinimumSystemVersion':declared_minimum,'notarized':False,'installerWorkflowAvailable':True,'runtimeVerified':False,'installed':False,'embeddedAgentValidated':True,'serviceRegistrationRequired':True,'autostartEnabled':False,'scheduleSeconds':60}
manifest_temp=stage/'.build-manifest.json.tmp'
manifest_temp.write_text(json.dumps(manifest,indent=2)+'\n')
manifest_temp.replace(stage/'build-manifest.json')
PY
print -r -- "Staged signed inactive app archive in $STAGE. It was not executed or installed; runtime access is unverified."
