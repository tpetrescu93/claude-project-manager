#!/usr/bin/env bash
# clone.sh — detached clone/fork/promote worker
#
# Args (all required, pass "" for optional ones):
#   $1  SOURCE_PATH
#   $2  TARGET_DIR
#   $3  BRANCH_NAME
#   $4  PENDING_FILE       path to write {name,rootPath,repoName[,kind]} JSON on success
#   $5  LOG_FILE
#   $6  ERROR_FILE         path to write {id,message,logFile} JSON on failure
#   $7  PENDING_ID         used inside the error JSON
#   $8  SESSION_ID         (fork/promote) Claude session ID to carry across; "" to skip
#   $9  SESSION_SRC_DIR    (fork/promote) ~/.claude/projects/<encoded-source>
#   $10 SESSION_DST_DIR    (fork/promote) ~/.claude/projects/<encoded-target>
#   $11 INV_SESSION_TO_KILL  (promote) tmux session name to kill after clone; "" to skip
#   $12 KIND               (promote) "investigation" to embed in pending JSON; "" to skip
set -euo pipefail

SOURCE_PATH="$1"
TARGET_DIR="$2"
BRANCH_NAME="$3"
PENDING_FILE="$4"
LOG_FILE="$5"
ERROR_FILE="$6"
PENDING_ID="$7"
SESSION_ID="${8:-}"
SESSION_SRC_DIR="${9:-}"
SESSION_DST_DIR="${10:-}"
INV_SESSION_TO_KILL="${11:-}"
KIND="${12:-}"

mkdir -p "$(dirname "$LOG_FILE")"
exec >> "$LOG_FILE" 2>&1

_on_error() {
    local line=$1
    local msg="Failed at line $line — see log: $LOG_FILE"
    printf '{"id":"%s","message":"%s","logFile":"%s"}' \
        "$PENDING_ID" "$msg" "$LOG_FILE" > "$ERROR_FILE"
}
trap '_on_error $LINENO' ERR

echo "=== clone started $(date) ==="

# 1. Local git clone — hardlinks .git objects, ~5x faster than rsync
git clone "$SOURCE_PATH" "$TARGET_DIR"

# 2. Reset to the canonical default branch's UP-TO-DATE upstream tip.
#
# The local clone above sets origin to the SOURCE folder, and its origin/HEAD
# mirrors whatever branch the source had checked out — so the old approach
# (git symbolic-ref refs/remotes/origin/HEAD) resolved to the source's feature
# branch, not the repo's real default, and reset to the source's stale local
# ref. Instead: repoint origin to the real upstream FIRST, ask the upstream what
# its default branch actually is (HEAD symref), fetch that, and reset to it.
cd "$TARGET_DIR"
_upstreamUrl=$(git -C "$SOURCE_PATH" remote get-url origin 2>/dev/null || echo "")

defaultBranch=""
if [ -n "$_upstreamUrl" ]; then
    git remote set-url origin "$_upstreamUrl"
    # Canonical default = the upstream's HEAD symref (main vs master, per GitHub).
    defaultBranch=$(git ls-remote --symref "$_upstreamUrl" HEAD 2>/dev/null \
        | sed -n 's#^ref: refs/heads/\([^[:space:]]*\).*#\1#p')
    if [ -n "$defaultBranch" ] && git fetch origin "$defaultBranch" 2>/dev/null; then
        git checkout -B "$defaultBranch" "origin/$defaultBranch"
    else
        defaultBranch=""   # detection/fetch failed — fall through to local fallback
    fi
fi

# Fallback (no upstream / offline / unset remote HEAD): pick a sane default that
# exists locally — explicitly NOT the source's checked-out branch.
if [ -z "$defaultBranch" ]; then
    git fetch origin 2>/dev/null || true
    for b in main master develop; do
        if git rev-parse --verify "origin/$b" >/dev/null 2>&1; then defaultBranch="$b"; break; fi
    done
    git checkout -f "$defaultBranch"
    git reset --hard "origin/$defaultBranch"
fi

# 3. Create new branch
git checkout -b "$BRANCH_NAME"

# 4. .venv: copy symlink if source has one, otherwise symlink the real dir
src_venv="$SOURCE_PATH/.venv"
if [ -L "$src_venv" ]; then
    cp -P "$src_venv" .venv
elif [ -d "$src_venv" ]; then
    ln -s "$src_venv" .venv
fi

# 5. bun install if JS lockfile present
if [ -f yarn.lock ] || [ -f package-lock.json ]; then
    bun install && rm -f bun.lock bun.lockb || true
fi

# 6. Copy Claude session (cwd-rewritten so --resume operates in the new folder)
if [ -n "$SESSION_ID" ] && [ -n "$SESSION_SRC_DIR" ] && [ -n "$SESSION_DST_DIR" ]; then
    mkdir -p "$SESSION_DST_DIR"
    srcJsonl="$SESSION_SRC_DIR/$SESSION_ID.jsonl"
    dstJsonl="$SESSION_DST_DIR/$SESSION_ID.jsonl"
    if [ -f "$srcJsonl" ]; then
        jq -c --arg cwd "$TARGET_DIR" 'if has("cwd") then .cwd = $cwd else . end' "$srcJsonl" > "$dstJsonl"
        srcSub="$SESSION_SRC_DIR/$SESSION_ID"
        dstSub="$SESSION_DST_DIR/$SESSION_ID"
        if [ -d "$srcSub" ]; then
            find "$srcSub" -type f | while IFS= read -r f; do
                rel="${f#$srcSub/}"
                dst="$dstSub/$rel"
                mkdir -p "$(dirname "$dst")"
                if echo "$f" | grep -q '\.jsonl$'; then
                    jq -c --arg cwd "$TARGET_DIR" 'if has("cwd") then .cwd = $cwd else . end' "$f" > "$dst"
                else
                    cp "$f" "$dst" 2>/dev/null || true
                fi
            done
        fi
    fi

    # Start tmux session resuming the copied Claude session.
    # NOTE: no "=" in -s — that's exact-match syntax for -t TARGETS only; in -s it
    # becomes part of the literal session name, orphaning the session from the
    # "Open Tmux Session" attach (which then creates an empty duplicate).
    sessionName=$(basename "$TARGET_DIR" | tr '.' '-')
    tmux new-session -d -s "$sessionName" -c "$TARGET_DIR" \
        bash -lic "claude --resume $SESSION_ID --dangerously-skip-permissions; exec bash -l" 2>/dev/null || true
fi

# 7. Kill investigation tmux session (promote only)
if [ -n "$INV_SESSION_TO_KILL" ]; then
    tmux kill-session -t "=$INV_SESSION_TO_KILL" 2>/dev/null || true
fi

# 8. Detect repo name from the upstream remote URL (origin was already repointed
#    to upstream in step 2).
_repoUrl=$(git remote get-url origin 2>/dev/null || echo "")
_repoName=$(echo "$_repoUrl" | sed -E 's|.*[:/][^/]+/([^/.]+)(\.git)?[[:space:]]*$|\1|')

# Strip "repoName-" prefix from the stored name if present
_storedName="$BRANCH_NAME"
if [ -n "$_repoName" ]; then
    _prefix="${_repoName}-"
    case "$_storedName" in
        "$_prefix"*) _storedName="${_storedName#$_prefix}" ;;
    esac
fi

# 9. Write pending file — signals the extension that the project is ready
mkdir -p "$(dirname "$PENDING_FILE")"
if [ -n "$KIND" ]; then
    printf '{"name":"%s","rootPath":"%s","repoName":"%s","kind":"%s"}' \
        "$_storedName" "$TARGET_DIR" "$_repoName" "$KIND" > "$PENDING_FILE"
else
    printf '{"name":"%s","rootPath":"%s","repoName":"%s"}' \
        "$_storedName" "$TARGET_DIR" "$_repoName" > "$PENDING_FILE"
fi

echo "=== done $(date) ==="
