#!/bin/sh
# Runs a CI step's command and, where it fails, puts its errors and last lines in an annotation,
# which anyone can read – unlike the job's log.
#
#   sh tools/ci-step.sh <title> <command> [<argument>...]
title=$1
shift
log=$(mktemp)
"$@" > "$log" 2>&1
status=$?
cat "$log"
if [ $status != 0 ]; then
  # GitHub's annotations take one line: newlines and percent signs written as it reads them.
  escape() { awk 'BEGIN { ORS = "%0A" } { gsub(/%/, "%25"); gsub(/\r/, ""); print }'; }
  errors=$(grep -E "error(\[E[0-9]+\])?:|panicked at|What went wrong|FAILED|No such file" -A4 "$log" | head -40)
  [ -n "$errors" ] && echo "::error title=$title: errors::$(printf '%s\n' "$errors" | escape)"
  echo "::error title=$title: last lines::$(tail -25 "$log" | escape)"
fi
rm -f "$log"
exit $status
