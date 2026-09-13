#!/usr/bin/env bash
# Copy the app's REAL data off a connected iPhone into the iOS Simulator's container.
#
#   scripts/sim-pull-db.sh              # database + clips
#   scripts/sim-pull-db.sh --no-videos  # database only (clips can be gigabytes)
#
# For taking screenshots — or reproducing a bug — against real athletes and real
# runs rather than seeded ones. Runs on the Mac; the Simulator must be booted and
# the app must have been launched in it at least once so its container exists.
#
# WHAT HAS TO BE TRUE, and each one fails in a way that looks like something else:
#
#   The build on the PHONE must be development-signed. A TestFlight or App Store
#   build's container is not readable by devicectl at all; it does not say so, it
#   just finds nothing. You build from origin with prebuild, so yours is.
#
#   FORCE-QUIT the app on the phone first. SQLite may hold recent writes in a WAL
#   sidecar; quitting checkpoints it. The copy below takes the sidecars too, in case.
#
#   The phone must be unlocked and trusted, and Xcode 15+ installed for devicectl.
#
# WHY A STRAIGHT COPY WORKS, verified against the repo rather than assumed: clip
# paths are derived from the clip id at runtime (clips.ts clipDir), never stored,
# so Documents/videos/<id>/ resolves under the Simulator's different container
# path. And sweepBrokenClips only removes clip DIRECTORIES with no file in them —
# it never touches a database row — so pulling the database without the clips is
# safe: those runs keep their clip_id and show the "video deleted" state.
#
# UNTESTED FROM WHERE IT WAS WRITTEN (a Windows machine with no Simulator). Every
# path and flag was checked against the code and Apple's tooling, not run.

set -euo pipefail

BUNDLE='com.equalsplit.app'
WITH_VIDEOS=1
[[ "${1:-}" == "--no-videos" ]] && WITH_VIDEOS=0

PULL="$(mktemp -d /tmp/equalsplit-pull.XXXXXX)"
echo "→ staging in $PULL"

# ---- 1. the phone ---------------------------------------------------------------
DEVICE="${DEVICE_ID:-$(xcrun devicectl list devices 2>/dev/null \
  | awk '/iPhone/ && /connected/ {print $NF; exit}')}"
if [[ -z "$DEVICE" ]]; then
  echo "!! no connected iPhone found. Plug it in, unlock it, or set DEVICE_ID=<udid>." >&2
  echo "   xcrun devicectl list devices" >&2
  exit 1
fi
echo "→ phone: $DEVICE"

pull() {
  xcrun devicectl device copy from \
    --device "$DEVICE" \
    --domain-type appDataContainer \
    --domain-identifier "$BUNDLE" \
    --source "$1" \
    --destination "$PULL/$1"
}
mkdir -p "$PULL/Documents"
pull Documents/SQLite
if [[ ! -f "$PULL/Documents/SQLite/equalsplit.db" ]]; then
  echo "!! equalsplit.db did not come back. Almost always: the phone has a TestFlight" >&2
  echo "   or App Store build, whose container devicectl cannot read. Install a dev build." >&2
  exit 1
fi
if [[ $WITH_VIDEOS -eq 1 ]]; then
  pull Documents/videos || echo "   (no videos directory on the phone — fine)"
fi

# ---- 2. the Simulator -----------------------------------------------------------
SIM="$(xcrun simctl get_app_container booted "$BUNDLE" data 2>/dev/null || true)"
if [[ -z "$SIM" ]]; then
  echo "!! no container for $BUNDLE in the booted Simulator." >&2
  echo "   Boot one, launch the app in it once so the container exists, then rerun." >&2
  exit 1
fi
echo "→ simulator container: $SIM"

# The app must not have the database open while it is replaced.
xcrun simctl terminate booted "$BUNDLE" 2>/dev/null || true

DOCS="$SIM/Documents"
mkdir -p "$DOCS"
if [[ -d "$DOCS/SQLite" ]]; then
  BAK="$DOCS/SQLite.before-pull.$(date +%Y%m%d-%H%M%S)"
  mv "$DOCS/SQLite" "$BAK"
  echo "→ existing Simulator database kept at $BAK"
fi
cp -R "$PULL/Documents/SQLite" "$DOCS/SQLite"
if [[ $WITH_VIDEOS -eq 1 && -d "$PULL/Documents/videos" ]]; then
  rm -rf "$DOCS/videos"
  cp -R "$PULL/Documents/videos" "$DOCS/videos"
fi

# ---- 3. say what arrived, so a silent empty copy cannot pass as success ------------
DB="$DOCS/SQLite/equalsplit.db"
if command -v sqlite3 >/dev/null; then
  ATH="$(sqlite3 "$DB" 'select count(*) from athletes;' 2>/dev/null || echo '?')"
  RUNS="$(sqlite3 "$DB" 'select count(*) from runs;' 2>/dev/null || echo '?')"
  CLIPS="$(sqlite3 "$DB" 'select count(*) from runs where clip_id is not null;' 2>/dev/null || echo '?')"
  echo "→ in the Simulator now: $ATH athletes, $RUNS runs, $CLIPS with video"
else
  echo "→ copied. (install sqlite3 to see counts)"
fi
if [[ $WITH_VIDEOS -eq 1 && -d "$DOCS/videos" ]]; then
  echo "→ clips on disk: $(find "$DOCS/videos" -name 'clip*' | wc -l | tr -d ' ')"
fi
echo "→ relaunch the app in the Simulator."
