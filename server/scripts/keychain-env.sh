#!/bin/zsh
# macOS only: read Fill Notes secrets from the login keychain into the environment, then run a command.
# Values are never printed. Missing items are simply left empty.
#   scripts/keychain-env.sh npm start
#   scripts/keychain-env.sh npx tsx scripts/check-keys.ts
k() { security find-generic-password -s "$1" -a "$USER" -w 2>/dev/null | tr -d '\r\n' || true; }
export BINANCE_TESTNET_API_KEY="${BINANCE_TESTNET_API_KEY:-$(k fillnotes-binance-testnet-key)}"
export BINANCE_TESTNET_API_SECRET="${BINANCE_TESTNET_API_SECRET:-$(k fillnotes-binance-testnet-secret)}"
export NOTION_TOKEN="${NOTION_TOKEN:-$(k fillnotes-notion-token)}"
exec "$@"
