/**
 * Margin Overview UI sidecar backend.
 * Read-only HTTP server backed by sidecar_sdk; reads transcript.jsonl and intent.json.
 */
import { Response, SidecarApp } from 'sidecar_sdk';
import { appDataDirs } from '../../lib/paths.mjs';
import { resolveOverview } from '../../lib/overview.mjs';
import { memoryStoreDirs, readMemoryDocument, renderMemoryViewHtml } from '../../lib/memory.mjs';
import { appHtml } from '../../mcp/server.mjs';

const app = new SidecarApp();
const memOpts = () => memoryStoreDirs({ isHermetic: false });

app.page('/', () => appHtml({ sidecar: true }));

app.api('/api/overview', (data) => {
  const conversationId = data.conversationId || app.config.conversationId || '';
  return resolveOverview({ conversationId, etag: data.etag || '' }, appDataDirs());
}, 'GET');

app.api('/api/memory-doc', (data) => readMemoryDocument(String(data.path || ''), memOpts()), 'GET');

app.api('/api/memory-view', (data) => {
  const r = renderMemoryViewHtml(String(data.path || ''), memOpts());
  return new Response(r.body, { contentType: r.contentType, status: r.status });
}, 'GET');

app.run();
