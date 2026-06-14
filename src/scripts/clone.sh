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
# Resolve the upstream default branch (main vs master) from the SOURCE's locally
# cached origin/HEAD — an instant ref read, no network. A `ls-remote --symref
# HEAD` would cost ~1.8s on repos with many refs (paydays-api advertises 50k+)
# just to learn a name that almost never changes. The cache is kept correct by
# the repo-sync job (canonical repos), by `git clone` (Add Git Repo), by the
# set-head stamp below (new clones), and by the one-time origin/HEAD migration
# (pre-existing project-list/archive clones) — so no network lookup is needed.
if [ -n "$_upstreamUrl" ]; then
    git remote set-url origin "$_upstreamUrl"

    defaultBranch=$(git -C "$SOURCE_PATH" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null \
        | sed 's#^origin/##')
    if [ -n "$defaultBranch" ] && git fetch origin "$defaultBranch" 2>/dev/null; then
        git checkout -B "$defaultBranch" "origin/$defaultBranch"
        # Stamp this new repo's origin/HEAD so a future clone FROM it is fast too.
        git remote set-head origin "$defaultBranch" 2>/dev/null || true
    else
        defaultBranch=""   # empty/unfetchable cache — fall through to local fallback
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

# 4. Replicate every .venv the source has, at the same relative path — a repo may
#    keep more than one (e.g. a per-subproject venv alongside the root one). A
#    symlink is copied verbatim (cp -P), a real dir is symlinked back to the source.
#    -prune stops find descending INTO a real .venv (thousands of files); maxdepth
#    keeps it to the repo's own venvs, not stray ones in deep fixtures.
( cd "$SOURCE_PATH" && find . -maxdepth 2 -name .venv \( -type l -o -type d \) -prune -print ) \
| while IFS= read -r rel; do
    rel="${rel#./}"
    src="$SOURCE_PATH/$rel"
    dst="$TARGET_DIR/$rel"
    mkdir -p "$(dirname "$dst")"
    if [ -L "$src" ]; then
        cp -P "$src" "$dst"
    elif [ -d "$src" ]; then
        ln -s "$src" "$dst"
    fi
done

# 5. bun install if JS lockfile present
if [ -f yarn.lock ] || [ -f package-lock.json ]; then
    bun install && rm -f bun.lock bun.lockb || true
fi

# 6. Eagerly start a primed Claude tmux session so opening the project later just
#    attaches to an already-booted Claude (same as fork). Fork/promote carry the
#    source conversation across and resume it; a plain clone starts a fresh Claude.
# NOTE: no "=" in -s — that's exact-match syntax for -t TARGETS only; in -s it
# becomes part of the literal session name, orphaning the session from the
# "Open Tmux Session" attach (which then creates an empty duplicate).
sessionName=$(basename "$TARGET_DIR" | tr '.' '-')
if [ -n "$SESSION_ID" ] && [ -n "$SESSION_SRC_DIR" ] && [ -n "$SESSION_DST_DIR" ]; then
    # Copy the source transcript (cwd-rewritten so --resume operates here).
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
    # Resume with a one-time orienting prompt: the conversation happened in the
    # source folder with its own branch/uncommitted work, but this is a clean
    # checkout on a fresh branch off latest default — tell Claude so it doesn't
    # recreate the prior git state, and park it. Passed as the positional [prompt]
    # arg (interactive resume submits it as the first turn). Single-quoted in the
    # -c string, so the message must contain no single quotes.
    PARK_MSG='Heads up: this is a forked session. The working directory is now a fresh clone on a new branch cut from the latest default branch, so any uncommitted changes or commits from earlier in this conversation are NOT present here. This is expected and nothing is broken. Do not try to recreate that prior state. Await my next instruction.'
    claudeCmd="claude --resume $SESSION_ID --dangerously-skip-permissions '$PARK_MSG'"
else
    # Plain clone: no conversation to carry — start a fresh Claude.
    claudeCmd="claude --dangerously-skip-permissions"
fi
tmux new-session -d -s "$sessionName" -c "$TARGET_DIR" \
    bash -lic "$claudeCmd; exec bash -l" 2>/dev/null || true

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
