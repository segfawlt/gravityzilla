/**
 * Margin Overview UI sidecar backend.
 * Read-only HTTP server backed by sidecar_sdk; reads transcript.jsonl and intent.json.
 */
import { SidecarApp } from 'sidecar_sdk';
import { appDataDirs } from '../../lib/paths.mjs';
import { resolveOverview } from '../../lib/overview.mjs';
import { appHtml } from '../../mcp/server.mjs';

const app = new SidecarApp();

app.page('/', () => appHtml({ sidecar: true }));

app.api('/api/overview', (data) => {
  const conversationId = data.conversationId || app.config.conversationId || '';
  return resolveOverview({ conversationId, etag: data.etag || '' }, appDataDirs());
}, 'GET');

app.run();
