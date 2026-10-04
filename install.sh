#!/bin/sh
set -eu

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' 'Please install Node.js 22 or newer: https://nodejs.org/' >&2
  exit 1
fi
node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$node_major" -lt 22 ]; then
  printf '%s\n' 'RoastCli requires Node.js 22 or newer: https://nodejs.org/' >&2
  exit 1
fi

package_url='https://github.com/Roast-2007/RoastCli/releases/latest/download/roastcli.tgz'
printf '%s\n' 'Installing RoastCli…'
npm install --global "$package_url"
printf '%s\n' 'Installed. Run roast config to set your API key, then run roast.'
