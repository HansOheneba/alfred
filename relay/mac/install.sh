#!/bin/zsh -f
# Default is help. Every live setup/activation operation is explicit.
unsetopt xtrace verbose allexport
set -euo pipefail
umask 077

LABEL="com.hansopoku.alfred-relay"
SUPPORT="$HOME/Library/Application Support/AlfredRelay"
BIN="$SUPPORT/alfred-relay"
INSTALLED_AGENT="$SUPPORT/$LABEL.plist"
INSTALLED_MANIFEST="$SUPPORT/interface.json"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
HERE="${0:A:h}"
STAGE="$HERE/build"

usage() {
  cat <<'HELP'
Usage: ./install.sh [command]

  --help         Show help (also the default).
  --prepare      Build/stage local files in relay/mac/build only.
  --install      Install executable and inactive definition in support folder.
  --configure --sender ID [--sender ID ...]
                 Create private config; read key silently from terminal.
                 No overwrite, SMS access, network request, or service start.
  --enable       Initialize future-only baseline if absent, then enable service.
                 Reads Messages and can begin sending new approved alerts.
  --status       Inspect installation/service and safe metadata. No SMS read.
  --disable      Disable future automatic starts and unload; retain all files.

Obtain explicit approval before installation, account key creation, config,
Full Disk Access, or activation. Preparing performs none of these actions.
HELP
}

fail() { print -u2 -r -- "$1"; exit 1; }
require_regular() {
  [[ -f "$1" && ! -L "$1" ]] || fail "Required regular file is missing or symlinked: $1"
}
service_loaded() {
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1
}
service_metadata() {
  # launchctl output can contain environment values: capture, never echo it.
  python3 - "$LABEL" <<'PY'
import json, os, re, subprocess, sys
result = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{sys.argv[1]}"], capture_output=True, text=True)
def number(name):
    match = re.search(r"^\s*" + re.escape(name) + r"\s*=\s*(-?\d+)\s*$", result.stdout, re.M)
    return int(match[1]) if match else None
state_match = re.search(r"^\s*state\s*=\s*([^\n]+)$", result.stdout, re.M)
state = state_match[1].strip() if state_match else "unknown"
if state not in {"running", "not running", "waiting", "exited", "spawn scheduled", "waiting for demand", "waiting on port", "throttled"}:
    state = "unknown"
last_exit = number("last exit code")
print(json.dumps({"launchAgentLoaded": result.returncode == 0, "state": state, "runs": number("runs"), "lastExitCode": last_exit}, sort_keys=True))
sys.exit(0 if result.returncode == 0 and state != "unknown" and last_exit in (None, 0) else 1)
PY
}
safe_support() {
  [[ ! -L "$SUPPORT" ]] || fail "Refusing symlinked support directory."
  mkdir -p "$SUPPORT"
  chmod 700 "$SUPPORT"
}
verify_build() {
  # Older relays ignore unknown flags and could send on --status/--initialize.
  # Never execute one: require the manifest produced with this prepared build.
  python3 - "$1" "$SUPPORT" "$LABEL" <<'PY'
import hashlib, json, os, pathlib, plistlib, stat, sys
try:
    base = pathlib.Path(sys.argv[1])
    info = base.lstat()
    if not stat.S_ISDIR(info.st_mode) or base.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError()
    support, label = pathlib.Path(sys.argv[2]), sys.argv[3]
    binary, manifest, agent = base / "alfred-relay", base / "interface.json", base / (label + ".plist")
    for path in (binary, manifest, agent):
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ValueError()
    with manifest.open(encoding="utf-8") as source:
        value = json.load(source)
    if type(value.get("interfaceVersion")) is not int or value["interfaceVersion"] != 1 or value.get("binarySHA256") != hashlib.sha256(binary.read_bytes()).hexdigest() or value.get("agentSHA256") != hashlib.sha256(agent.read_bytes()).hexdigest():
        raise ValueError()
    with agent.open("rb") as source:
        definition = plistlib.load(source)
    expected = {
        "Label": label, "Disabled": True,
        "ProgramArguments": [str(support / "alfred-relay")],
        "WatchPaths": [str(pathlib.Path.home() / "Library/Messages/chat.db-wal")],
        "StartInterval": 120, "ThrottleInterval": 10, "RunAtLoad": True,
        "StandardErrorPath": str(support / "relay.log"),
        "StandardOutPath": str(support / "relay.log"),
    }
    if definition != expected:
        raise ValueError()
except Exception:
    print("Safe relay binary/LaunchAgent manifest missing or mismatched; executable was not run.", file=sys.stderr)
    sys.exit(1)
PY
}
validate_config() {
  require_regular "$SUPPORT/config.json"
  python3 - "$SUPPORT/config.json" <<'PY'
import json, os, re, stat, sys
allowed = {"absa", "mobilemoney", "hubtel", "paysmall", "t-cash", "vf-cash", "t cash", "stanchart"}
try:
    path = sys.argv[1]
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError()
    with open(path, encoding="utf-8") as source:
        value = json.load(source)
    senders = value.get("senderAllowlist")
    if type(value.get("version")) is not int or value["version"] != 1 or not isinstance(value.get("key"), str) or not re.fullmatch(r"alf_[A-Za-z0-9_-]{20,64}", value["key"]):
        raise ValueError()
    if not isinstance(senders, list) or not senders or not all(isinstance(s, str) and s in allowed for s in senders) or len(set(senders)) != len(senders):
        raise ValueError()
except Exception:
    print("Config missing, invalid, unsupported, or not private to this user; no values displayed.", file=sys.stderr)
    sys.exit(1)
PY
}

action="${1:---help}"
(( $# == 0 )) || shift
case "$action" in
  --help|-h)
    (( $# == 0 )) || fail "Unexpected arguments."
    usage
    ;;
  --prepare)
    (( $# == 0 )) || fail "Unexpected arguments."
    [[ ! -L "$STAGE" ]] || fail "Refusing symlinked build directory."
    mkdir -p "$STAGE"
    BUILD_DIR="$(mktemp -d "$STAGE/.compile.XXXXXX")"
    trap 'rm -rf "$BUILD_DIR"' EXIT
    { print -r -- 'let sandboxProfile = #"""'; cat "$HERE/sandbox.sb"; print -r -- '"""#'; } > "$BUILD_DIR/Profile.swift"
    cp "$HERE/AlfredRelay.swift" "$BUILD_DIR/main.swift"
    swiftc -O -module-cache-path "$BUILD_DIR/module-cache" "$BUILD_DIR/main.swift" "$BUILD_DIR/Profile.swift" -o "$BUILD_DIR/alfred-relay"
    python3 - "$SUPPORT" "$HOME/Library/Messages/chat.db-wal" "$LABEL" "$BUILD_DIR" <<'PY'
import hashlib, json, pathlib, plistlib, sys
support, watched, label, output = sys.argv[1:]
output = pathlib.Path(output)
agent = {
    "Label": label, "Disabled": True,
    "ProgramArguments": [str(pathlib.Path(support) / "alfred-relay")],
    "WatchPaths": [watched], "StartInterval": 120, "ThrottleInterval": 10,
    "RunAtLoad": True,
    "StandardErrorPath": str(pathlib.Path(support) / "relay.log"),
    "StandardOutPath": str(pathlib.Path(support) / "relay.log"),
}
with (output / (label + ".plist")).open("wb") as target:
    plistlib.dump(agent, target)
with (output / "config.example.json").open("w", encoding="utf-8") as target:
    json.dump({"version": 1, "key": "", "senderAllowlist": []}, target, indent=2)
    target.write("\n")
with (output / "interface.json").open("w", encoding="utf-8") as target:
    json.dump({"interfaceVersion": 1, "binarySHA256": hashlib.sha256((output / "alfred-relay").read_bytes()).hexdigest(), "agentSHA256": hashlib.sha256((output / (label + ".plist")).read_bytes()).hexdigest()}, target)
    target.write("\n")
PY
    mv -f "$BUILD_DIR/alfred-relay" "$STAGE/alfred-relay"
    mv -f "$BUILD_DIR/$LABEL.plist" "$STAGE/$LABEL.plist"
    mv -f "$BUILD_DIR/config.example.json" "$STAGE/config.example.json"
    mv -f "$BUILD_DIR/interface.json" "$STAGE/interface.json"
    print -r -- "Prepared local files in $STAGE. Nothing installed, configured, read from Messages, or started."
    ;;
  --install)
    (( $# == 0 )) || fail "Unexpected arguments."
    service_loaded && fail "The service is loaded. Disable it explicitly before replacing files."
    [[ ! -e "$AGENT" && ! -L "$AGENT" ]] || fail "Existing LaunchAgents definition will not be replaced. Resolve the existing installation explicitly."
    require_regular "$STAGE/alfred-relay"
    require_regular "$STAGE/$LABEL.plist"
    verify_build "$STAGE"
    [[ ! -L "$BIN" && ! -L "$INSTALLED_AGENT" && ! -L "$INSTALLED_MANIFEST" && ! -L "$BIN.new" && ! -L "$INSTALLED_AGENT.new" && ! -L "$INSTALLED_MANIFEST.new" ]] || fail "Refusing symlinked installation files."
    safe_support
    install -m 700 "$STAGE/alfred-relay" "$BIN.new"
    install -m 600 "$STAGE/$LABEL.plist" "$INSTALLED_AGENT.new"
    install -m 600 "$STAGE/interface.json" "$INSTALLED_MANIFEST.new"
    mv -f "$BIN.new" "$BIN"
    mv -f "$INSTALLED_AGENT.new" "$INSTALLED_AGENT"
    mv -f "$INSTALLED_MANIFEST.new" "$INSTALLED_MANIFEST"
    print 'Installed executable and inactive definition in support folder; no login/start registration created.'
    print 'Config/state preserved. Installation does not establish Messages access, account linkage or delivery.'
    ;;
  --configure)
    typeset -a SENDERS
    SENDERS=()
    while (( $# )); do
      [[ "$1" == "--sender" && $# -ge 2 ]] || fail "Use one or more explicit --sender ID arguments."
      case "$2" in
        absa|mobilemoney|hubtel|paysmall|t-cash|vf-cash|'t cash'|stanchart) SENDERS+=("$2") ;;
        *) fail "Unsupported sender ID. See README.md for supported exact IDs." ;;
      esac
      shift 2
    done
    (( ${#SENDERS} > 0 )) || fail "At least one explicit sender ID is required."
    [[ ! -e "$SUPPORT/config.json" && ! -L "$SUPPORT/config.json" ]] || fail "Existing config will not be overwritten."
    [[ -t 0 && -w /dev/tty ]] || fail "Configuration requires an interactive terminal; keys are not accepted as arguments or environment variables."
    safe_support
    # Remove an inherited export attribute before accepting private input.
    unset KEY
    typeset KEY
    print -n -u2 -r -- "Paste the key for the approved signed-in Alfred account (input hidden): "
    IFS= read -rs KEY </dev/tty || fail "Key entry cancelled."
    print -u2
    trap 'unset KEY' EXIT
    # The key uses stdin only: never argv, environment, output, or a temporary file.
    print -rn -- "$KEY" | python3 -c '
import json, os, re, sys
key = sys.stdin.read()
if not re.fullmatch(r"alf_[A-Za-z0-9_-]{20,64}", key):
    print("Invalid forwarding-key format; nothing saved.", file=sys.stderr)
    sys.exit(1)
path, *senders = sys.argv[1:]
value = {"version": 1, "key": key, "senderAllowlist": list(dict.fromkeys(senders))}
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as target:
        json.dump(value, target)
        target.write("\n")
        target.flush()
        os.fsync(target.fileno())
except BaseException:
    os.unlink(path)
    raise
' "$SUPPORT/config.json" "${SENDERS[@]}"
    unset KEY
    print 'Private config created. Account ownership/key validity unverified; nothing sent.'
    ;;
  --enable)
    (( $# == 0 )) || fail "Unexpected arguments."
    service_loaded && fail "Service is already loaded; no action taken."
    require_regular "$BIN"
    require_regular "$INSTALLED_AGENT"
    verify_build "$SUPPORT"
    validate_config
    [[ ! -e "$SUPPORT/last-rowid" && ! -L "$SUPPORT/last-rowid" ]] || fail "Legacy cursor exists. Resolve migration explicitly; it will not be silently replaced."
    [[ ! -L "$HOME/Library/LaunchAgents" && ! -L "$AGENT" ]] || fail "Refusing symlinked LaunchAgent path."
    if [[ -e "$AGENT" ]]; then
      require_regular "$AGENT"
      cmp -s "$INSTALLED_AGENT" "$AGENT" || fail "Different existing LaunchAgent definition will not be replaced."
    else
      # Preflight write permissions before establishing the future-only baseline.
      # This pending filename is not a .plist and is not discoverable at login.
      mkdir -p "$HOME/Library/LaunchAgents"
      PENDING_AGENT="$(mktemp "$HOME/Library/LaunchAgents/.alfred-relay.XXXXXX")"
      trap 'rm -f "$PENDING_AGENT"' EXIT
      install -m 600 "$INSTALLED_AGENT" "$PENDING_AGENT"
    fi
    if [[ ! -e "$SUPPORT/state.json" && ! -L "$SUPPORT/state.json" ]]; then
      "$BIN" --initialize
    fi
    # Status validates baseline/config without reading Messages or contacting Alfred.
    "$BIN" --status
    if [[ -n "${PENDING_AGENT:-}" ]]; then mv -f "$PENDING_AGENT" "$AGENT"; fi
    launchctl enable "gui/$(id -u)/$LABEL"
    if ! launchctl bootstrap "gui/$(id -u)" "$AGENT"; then
      launchctl disable "gui/$(id -u)/$LABEL"
      fail "Activation failed; future automatic starts disabled. Inspect registration before retrying."
    fi
    print 'Service loaded. Registration alone does not prove a successful run or accepted delivery; inspect --status.'
    ;;
  --status)
    (( $# == 0 )) || fail "Unexpected arguments."
    STATUS_EXIT=0
    if [[ -f "$BIN" && ! -L "$BIN" && -x "$BIN" ]]; then print 'executable: installed'; else print 'executable: absent or unsafe'; STATUS_EXIT=1; fi
    if [[ -f "$INSTALLED_AGENT" && ! -L "$INSTALLED_AGENT" ]]; then print 'inactive_definition: present'; else print 'inactive_definition: absent or unsafe'; STATUS_EXIT=1; fi
    if [[ -f "$AGENT" && ! -L "$AGENT" ]] && cmp -s "$INSTALLED_AGENT" "$AGENT"; then print 'login_definition: matches'; else print 'login_definition: absent, unsafe, or mismatched'; STATUS_EXIT=1; fi
    if ! service_metadata; then STATUS_EXIT=1; fi
    if [[ -f "$BIN" && ! -L "$BIN" && -x "$BIN" ]]; then
      if verify_build "$SUPPORT"; then
        if ! "$BIN" --status; then STATUS_EXIT=1; fi
      else
        print 'relay_metadata: unavailable for unverified/legacy executable'
        STATUS_EXIT=1
      fi
    fi
    print 'Status exit 0 means complete setup metadata; it does not establish runtime health or delivery.'
    exit "$STATUS_EXIT"
    ;;
  --disable)
    (( $# == 0 )) || fail "Unexpected arguments."
    launchctl disable "gui/$(id -u)/$LABEL"
    if service_loaded; then launchctl bootout "gui/$(id -u)/$LABEL"; fi
    print 'Future automatic starts disabled and service unloaded. Config, state and definitions retained.'
    ;;
  *) usage >&2; fail "Unknown command. No action taken." ;;
esac
