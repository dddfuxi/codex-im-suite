# Troubleshooting

## Bridge won't start

**Symptoms**: `/claude-to-im start` fails or daemon exits immediately.

**Steps**:

1. Run `/claude-to-im doctor` to identify the issue
2. Check that Node.js >= 20 is installed: `node --version`
3. Check that Claude Code CLI is available: `claude --version`
4. Verify config exists: `ls -la ~/.claude-to-im/config.env`
5. Check logs for startup errors: `/claude-to-im logs`

**Common causes**:
- Missing or invalid config.env -- run `/claude-to-im setup`
- Node.js not found or wrong version -- install Node.js >= 20
- Port or resource conflict -- check if another instance is running with `/claude-to-im status`

## Messages not received

**Symptoms**: Bot is online but doesn't respond to messages.

**Steps**:

1. Verify the bot token is valid: `/claude-to-im doctor`
2. Check allowed user IDs in config -- if set, only listed users can interact
3. For Telegram: ensure you've sent `/start` to the bot first
4. For Discord: verify the bot has been invited to the server with message read permissions
5. For Feishu: confirm the app has been approved and event subscriptions are configured
6. Check logs for incoming message events: `/claude-to-im logs 200`

## Feishu permissions, events, and cloud documents

**Symptoms**: Feishu messages arrive partially, card buttons do nothing, streaming cards are not updated, mentions/member lookup fails, attachments cannot be read, or Docx/Sheets/Base links return empty or permission errors.

**Steps**:

1. In Feishu Developer Console, verify the needed API permissions are enabled for the correct token type: application identity (`tenant_access_token`) or user identity (`user_access_token`).
2. Create a new app version and wait for tenant admin approval. Permission, event, callback, and bot capability changes do not become effective just because they are checked in the console.
3. For inbound messages, verify Events & Callbacks uses long connection mode and includes `im.message.receive_v1`.
4. For card buttons and reminder completion, verify callback `card.action.trigger` is configured, saved while the bridge is connected, then published and approved.
5. For cloud documents, verify both Open Platform scopes and document resource authorization. The app/user token must have Docx/Drive/Sheets/Base scopes, and the document must be shared with the app or the requesting user.
6. Restart the bridge after platform changes, then run `/feishu` as an owner to compare declared `CTI_FEISHU_GRANTED_SCOPES`, actual API probes, OAuth scopes, and missing capabilities.

**Important**: `admin:app.admin_id:readonly` and `admin:app.admin:check` only support app-admin diagnostics. They do not grant message, card, member, attachment, or document permissions.

## Permission timeout

**Symptoms**: Claude Code session starts but times out waiting for tool approval.

**Steps**:

1. The bridge runs Claude Code in non-interactive mode; ensure your Claude Code configuration allows the necessary tools
2. Consider using `--allowedTools` in your configuration to pre-approve common tools
3. Check network connectivity if the timeout occurs during API calls

## High memory usage

**Symptoms**: The daemon process consumes increasing memory over time.

**Steps**:

1. Check current memory usage: `/claude-to-im status`
2. Restart the daemon to reset memory:
   ```
   /claude-to-im stop
   /claude-to-im start
   ```
3. If the issue persists, check how many concurrent sessions are active -- each Claude Code session consumes memory
4. Review logs for error loops that may cause memory leaks

## Stale PID file

**Symptoms**: Status shows "running" but the process doesn't exist, or start refuses because it thinks a daemon is already running.

The daemon management script (`daemon.sh`) handles stale PID files automatically. If you still encounter issues:

1. Run `/claude-to-im stop` -- it will clean up the stale PID file
2. If stop also fails, manually remove the PID file:
   ```bash
   rm ~/.claude-to-im/runtime/bridge.pid
   ```
3. Run `/claude-to-im start` to launch a fresh instance
