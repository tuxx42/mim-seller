#!/usr/bin/env fish
# Local runner: pulls secrets from the macOS Keychain so they never live in a
# file or in shell history. Non-secret config is set inline below.
#
# On Railway this script is ignored — set the same vars as Railway Variables.
#
# Keychain item: service "telegram bot token", account "TELEGRAM_BOT_TOKEN".
# To re-store (input hidden, never echoed):
#   security add-generic-password -a TELEGRAM_BOT_TOKEN -s "telegram bot token" -w
# Optionally store the chat id under service "telegram chat id".

set -l token (security find-generic-password -a TELEGRAM_BOT_TOKEN -s "telegram bot token" -w 2>/dev/null)
if test $status -ne 0
    echo "No Keychain entry for the bot token. Store it first with:"
    echo "  security add-generic-password -a TELEGRAM_BOT_TOKEN -s \"telegram bot token\" -w"
    exit 1
end
set -gx TELEGRAM_BOT_TOKEN $token

# Chat id is not secret; pull from Keychain if present, else set it here.
set -l chat (security find-generic-password -a TELEGRAM_CHAT_ID -s "telegram chat id" -w 2>/dev/null)
if test $status -eq 0
    set -gx TELEGRAM_CHAT_ID $chat
else if not set -q TELEGRAM_CHAT_ID
    echo "Set TELEGRAM_CHAT_ID (env, Keychain, or edit this script) and re-run."
    exit 1
end

# Wallet (and any other local-only config) live in wallet.local.fish, which is
# gitignored so no addresses are ever committed. Create it once with:
#   echo 'set -gx WALLET_ADDRESS 0xYourWallet' > wallet.local.fish
if test -f wallet.local.fish
    source wallet.local.fish
end
if not set -q WALLET_ADDRESS
    echo "WALLET_ADDRESS not set. Put it in wallet.local.fish (gitignored)."
    exit 1
end
# Keep local state out of the repo working dir if you like:
# set -gx STATE_FILE ./state.json

node index.js
