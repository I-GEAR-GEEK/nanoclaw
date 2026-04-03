/**
 * Google Chat Channel for NanoClaw
 *
 * Supports two Google Chat event formats:
 *   1. Google Workspace Add-on format (event.chat.messagePayload) — @mentions only
 *   2. Regular Chat app format (event.type === 'MESSAGE') — all messages if app
 *      is configured in Cloud Console to receive all messages without @mention.
 *
 * To enable receiving all messages (no @mention required):
 *   Google Cloud Console → Google Chat API → Configuration → under "Functionality"
 *   enable "Receive 1:1 messages and join spaces to post messages" AND check
 *   "Receive messages from spaces where this app is installed" (or equivalent).
 *   Once that is done no code changes are needed — this handler supports it already.
 *
 * Environment variables required:
 *   GOOGLE_CHAT_ENABLED=true
 *   GOOGLE_CHAT_SERVICE_ACCOUNT_PATH=/path/to/service-account-key.json
 *   GOOGLE_CHAT_WEBHOOK_PORT=3002  (optional, default: 3002)
 *   GOOGLE_CHAT_WEBHOOK_SECRET=your_secret_token  (optional but recommended)
 */

import express, { Request, Response } from 'express';
import { google } from 'googleapis';
import { readEnvFile } from '../env.js';
import { registerChannel } from './registry.js';
import type { ChannelOpts } from './registry.js';
import type { Channel } from '../types.js';
import { getRouterState, setRouterState } from '../db.js';

const envVars = readEnvFile([
  'GOOGLE_CHAT_ENABLED',
  'GOOGLE_CHAT_SERVICE_ACCOUNT_PATH',
  'GOOGLE_CHAT_WEBHOOK_PORT',
  'GOOGLE_CHAT_WEBHOOK_SECRET',
]);

const GOOGLE_CHAT_ENABLED = envVars.GOOGLE_CHAT_ENABLED === 'true';
const SERVICE_ACCOUNT_PATH = envVars.GOOGLE_CHAT_SERVICE_ACCOUNT_PATH || '';
const WEBHOOK_PORT = parseInt(envVars.GOOGLE_CHAT_WEBHOOK_PORT || '3002', 10);
const WEBHOOK_SECRET = envVars.GOOGLE_CHAT_WEBHOOK_SECRET || '';

const MAX_MESSAGE_LENGTH = 4096;

class GoogleChatChannel implements Channel {
  name = 'google-chat';

  private opts: ChannelOpts;
  private connected = false;
  private chatClient: ReturnType<typeof google.chat> | null = null;
  private server: ReturnType<typeof express.application.listen> | null = null;
  // Persist thread name per space JID in DB so replies survive restarts
  private getThreadName(jid: string): string | undefined {
    return getRouterState(`gc_thread:${jid}`);
  }
  private setThreadName(jid: string, threadName: string): void {
    setRouterState(`gc_thread:${jid}`, threadName);
  }
  private clearThreadName(jid: string): void {
    setRouterState(`gc_thread:${jid}`, '');
  }

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const auth = new google.auth.GoogleAuth({
      keyFile: SERVICE_ACCOUNT_PATH,
      scopes: ['https://www.googleapis.com/auth/chat.bot'],
    });
    this.chatClient = google.chat({ version: 'v1', auth });

    const app = express();
    app.use(express.json());

    app.post('/google-chat/webhook', async (req: Request, res: Response) => {
      try {
        if (WEBHOOK_SECRET) {
          const token = req.headers['x-goog-channel-token'] || req.query.token;
          if (token !== WEBHOOK_SECRET) {
            res.status(401).json({ error: 'Unauthorized' });
            return;
          }
        }
        const event = req.body;
        res.json({});
        console.log('[google-chat] RAW EVENT:', JSON.stringify(event));
        await this.handleEvent(event);
      } catch (err) {
        console.error('[google-chat] Webhook error:', err);
      }
    });

    app.get('/google-chat/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', connected: this.connected });
    });

    await new Promise<void>((resolve) => {
      this.server = app.listen(WEBHOOK_PORT, () => {
        console.log(`[google-chat] Webhook server listening on port ${WEBHOOK_PORT}`);
        resolve();
      });
    });

    this.connected = true;
    console.log('[google-chat] Channel connected ✓');
  }

  private async handleEvent(event: any): Promise<void> {
    // --- Format 1: Google Workspace Add-on format (event.chat.messagePayload) ---
    if (event.chat?.messagePayload) {
      await this.handleAddonMessage(event.chat.messagePayload, event.chat.eventTime);
      return;
    }

    // --- Format 2: Regular Chat app format (event.type) ---
    if (event.type === 'MESSAGE' && event.message) {
      await this.handleChatAppMessage(event.message, event.space);
      return;
    }

    // --- Bot added to space (Add-on format, no messagePayload) ---
    if (event.chat && !event.chat.messagePayload && event.chat.eventTime) {
      const space = event.chat.space || { name: '', displayName: 'Unknown' };
      const jid = `gc:${space.name}`;
      console.log(`[google-chat] Added to space: ${space.displayName || space.name} (${jid})`);
      this.opts.onChatMetadata(jid, new Date().toISOString(), space.displayName || space.name, 'google-chat',
        space.type === 'ROOM' || space.type === 'SPACE');
      return;
    }

    // --- Bot added to space (regular Chat app format) ---
    if (event.type === 'ADDED_TO_SPACE' && event.space) {
      const jid = `gc:${event.space.name}`;
      console.log(`[google-chat] Added to space: ${event.space.displayName || event.space.name} (${jid})`);
      this.opts.onChatMetadata(jid, new Date().toISOString(), event.space.displayName || event.space.name, 'google-chat',
        event.space.type === 'ROOM' || event.space.type === 'SPACE');
    }
  }

  private async handleAddonMessage(payload: any, eventTime?: string): Promise<void> {
    const message = payload.message;
    const space = payload.space;
    if (!message || message.sender?.type === 'BOT') return;

    const spaceName = space?.name || '';
    const jid = `gc:${spaceName}`;
    const senderId = message.sender?.name || 'unknown';
    const senderName = message.sender?.displayName || senderId;
    // argumentText strips the @mention prefix; fall back to full text for non-mention events
    const text = (message.argumentText || message.text || '').trim();
    if (!text) return;
    const timestamp = message.createTime || eventTime || new Date().toISOString();
    const isGroupSpace = space?.type === 'ROOM' || space?.type === 'SPACE' || space?.spaceType === 'SPACE';

    const threadName = message.thread?.name as string | undefined;
    if (threadName) this.setThreadName(jid, threadName);

    this.opts.onChatMetadata(jid, timestamp, space?.displayName || spaceName, 'google-chat', isGroupSpace);
    this.opts.onMessage(jid, {
      id: message.name || `gc_${Date.now()}`,
      chat_jid: jid,
      sender: senderId,
      sender_name: senderName,
      content: text,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  private async handleChatAppMessage(message: any, space: any): Promise<void> {
    if (!message || message.sender?.type === 'BOT') return;

    const spaceName = space?.name || message.space?.name || '';
    const jid = `gc:${spaceName}`;
    const senderId = message.sender?.name || 'unknown';
    const senderName = message.sender?.displayName || senderId;
    // For regular Chat app events, text has the full message (no @mention stripping needed)
    const text = (message.text || '').trim();
    if (!text) return;
    const timestamp = message.createTime || new Date().toISOString();
    const spaceObj = space || message.space || {};
    const isGroupSpace = spaceObj.type === 'ROOM' || spaceObj.type === 'SPACE' || spaceObj.spaceType === 'SPACE';

    const threadName = message.thread?.name as string | undefined;
    if (threadName) this.setThreadName(jid, threadName);

    this.opts.onChatMetadata(jid, timestamp, spaceObj.displayName || spaceName, 'google-chat', isGroupSpace);
    this.opts.onMessage(jid, {
      id: message.name || `gc_${Date.now()}`,
      chat_jid: jid,
      sender: senderId,
      sender_name: senderName,
      content: text,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.chatClient) throw new Error('[google-chat] Not connected');

    const parent = jid.replace('gc:', '');
    const threadName = this.getThreadName(jid) || undefined;

    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
      chunks.push(text.slice(i, i + MAX_MESSAGE_LENGTH));
    }

    for (const chunk of chunks) {
      const requestBody: Record<string, any> = { text: chunk };
      if (threadName) {
        requestBody.thread = { name: threadName };
      }
      try {
        await this.chatClient.spaces.messages.create({
          parent,
          ...(threadName && { messageReplyOption: 'REPLY_MESSAGE_OR_FAIL' }),
          requestBody,
        });
      } catch (err: any) {
        // Thread no longer exists — send without thread context
        if (threadName && err?.code === 404) {
          this.clearThreadName(jid);
          delete requestBody.thread;
          await this.chatClient.spaces.messages.create({
            parent,
            requestBody,
          });
        } else {
          throw err;
        }
      }
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Google Chat does not support typing indicators and deleting
    // placeholder messages leaves a "Message deleted" tombstone.
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gc:');
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.connected = false;
    console.log('[google-chat] Channel disconnected');
  }
}

registerChannel('google-chat', (opts: ChannelOpts) => {
  if (!GOOGLE_CHAT_ENABLED) {
    console.log('[google-chat] Disabled (GOOGLE_CHAT_ENABLED != true)');
    return null;
  }
  if (!SERVICE_ACCOUNT_PATH) {
    console.log('[google-chat] Disabled (GOOGLE_CHAT_SERVICE_ACCOUNT_PATH not set)');
    return null;
  }
  return new GoogleChatChannel(opts);
});
