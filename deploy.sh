#!/bin/sh
# Stamp asset links with a fresh version so browsers don't mix old and new files, then publish.
set -e
cd "$(dirname "$0")"
v=$(date +%Y%m%d%H%M%S)
sed -i -E "s/(app\.js|style\.css)(\?v=[0-9]+)?\"/\1?v=$v\"/g" index.html
node --check app.js
git add -A
git -c user.name="22350" -c user.email="poberman66@gmail.com" commit -q -m "${1:-Update}

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -q
git log --oneline -1
