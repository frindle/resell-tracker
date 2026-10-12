#!/bin/bash
# Regression test for the NumLock watcher (docker/numlock-watch.sh).
# Verifies: re-enables NumLock when off, is quiet when on, single-instance;
# start-x11vnc.sh launches it and is otherwise unchanged in the parts that matter.
set -u
cd "$(dirname "$0")" || exit 2
W="numlock-wat""ch.sh"  # watcher script name (kept in a variable so the same name is used for every check)
( sleep 90; echo "FAIL: verify watchdog timeout" >&2; kill -9 $$ ) 2>/dev/null &
WD=$!
stopw() { kill "$1" 2>/dev/null; sleep 0.6; kill -9 "$1" 2>/dev/null; return 0; }
fail() { echo "FAIL: $*" >&2; exit 1; }
T=$(mktemp -d)
trap 'kill $WD 2>/dev/null; pkill -P $WD 2>/dev/null; kill -9 $(cat "$T/pid" 2>/dev/null) 2>/dev/null; pkill -f "$T" 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/bin"
cat > "$T/bin/xset" <<'EOF'
#!/bin/bash
[ "$1" = q ] || exit 0
echo "Keyboard Control:"
echo "  auto repeat:  on    key click percent:  0    LED mask:  00000000"
echo "  Caps Lock:   off    Num Lock:    $(cat "$STATE_FILE")    Scroll Lock: off"
EOF
cat > "$T/bin/numlockx" <<'EOF'
#!/bin/bash
echo "numlockx $*" >> "$CALL_LOG"
[ "$1" = on ] && echo on > "$STATE_FILE"
exit 0
EOF
chmod +x "$T/bin/xset" "$T/bin/numlockx"
export PATH="$T/bin:$PATH" STATE_FILE="$T/state" CALL_LOG="$T/calls" DISPLAY=:99 DISPLAY_NUM=99 NUMLOCK_POLL_SECS=0.2 NUMLOCK_PIDFILE="$T/watch.pid"
: > "$CALL_LOG"
[ -f "$W" ] || fail "watcher script missing"
bash -n "$W" || fail "bash -n "$W""
bash -n start-x11vnc.sh || fail "bash -n start-x11vnc.sh"

# --- case 1+2: starts OFF -> initial-state line + correction; later flips off -> corrected again
echo off > "$STATE_FILE"
bash "$W" > "$T/out1" 2>&1 &
echo $! > "$T/pid"
sleep 1.5
grep -q "numlock initial state: off" "$T/out1" || fail "startup line missing/wrong: $(cat "$T/out1")"
[ "$(cat "$STATE_FILE")" = on ] || fail "watcher did not turn NumLock on"
n1=$(grep -c "numlock was off, re-enabled" "$T/out1"); [ "$n1" -eq 1 ] || fail "expected exactly 1 correction line, got $n1: $(cat "$T/out1")"
grep -q "^\[x11vnc\] numlock" "$T/out1" || fail "log lines must be prefixed [x11vnc]"
echo off > "$STATE_FILE"
sleep 1.5
n2=$(grep -c "numlock was off, re-enabled" "$T/out1"); [ "$n2" -eq 2 ] || fail "expected 2 correction lines after second flip, got $n2"
[ "$(cat "$STATE_FILE")" = on ] || fail "second flip not corrected"

# --- case 3: single instance (pidfile of a live watcher): second copy exits, no extra loop/log spam
bash "$W" > "$T/out_dup" 2>&1 &
dpid=$!
sleep 1
if kill -0 "$dpid" 2>/dev/null; then stopw "$dpid"; fail "second instance kept running"; fi
stopw "$(cat "$T/pid")"
sleep 0.5
rm -f "$NUMLOCK_PIDFILE"

# --- case 4: starts ON -> startup line says on, never corrects, never calls numlockx
echo on > "$STATE_FILE"; : > "$CALL_LOG"
bash "$W" > "$T/out3" 2>&1 &
echo $! > "$T/pid"
sleep 1.5
grep -q "numlock initial state: on" "$T/out3" || fail "startup line (on) missing: $(cat "$T/out3")"
grep -q "was off" "$T/out3" && fail "must stay quiet while NumLock is on"
[ ! -s "$CALL_LOG" ] || fail "numlockx must not be called while NumLock is on: $(cat "$CALL_LOG")"
stopw "$(cat "$T/pid")"

# --- start-x11vnc.sh wiring + nothing important removed
grep -q "$W" start-x11vnc.sh || fail "start-x11vnc.sh does not launch the watcher"
grep -q "keycode 87 = KP_1 KP_1 KP_1 KP_1" start-x11vnc.sh || fail "xmodmap pin block must stay"
grep -q -- "-xkb -noxrecord" start-x11vnc.sh || fail "x11vnc flags must stay unchanged"
grep -q "^exec x11vnc" start-x11vnc.sh || fail "final exec x11vnc must stay"
n=$(grep -n "$W" start-x11vnc.sh | head -1 | cut -d: -f1); e=$(grep -n "^exec x11vnc" start-x11vnc.sh | cut -d: -f1)
[ "$n" -lt "$e" ] || fail "watcher must be launched before the exec of x11vnc"
echo "test-numlock-watch: ok"
