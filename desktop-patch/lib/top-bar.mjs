// Main-process patch for dist/main.js that hides the hub UI top menu bar.
export const TOP_BAR_PATCH_START = '/* agy-top-bar-patch:start v1 */';
export const TOP_BAR_PATCH_END = '/* agy-top-bar-patch:end */';
export const LEGACY_TOP_BAR_MARKER = '// Local patch: hide the top menu bar in the hub UI.';
export const TOP_BAR_ANCHOR = '    void (0, beyondcorpPac_1.configureWebviewSessionProxy)(contents.session);\n});';

/** Return true if dist/main.js already contains either the marked or legacy hide-top-bar patch. */
export function hasTopBarPatch(source) {
  const hasMarkers = source.includes(TOP_BAR_PATCH_START) && source.includes(TOP_BAR_PATCH_END);
  return hasMarkers || source.includes(LEGACY_TOP_BAR_MARKER);
}

/** Render the self-contained main-process snippet injected after TOP_BAR_ANCHOR. */
export function renderTopBarSnippet() {
  return [
    TOP_BAR_PATCH_START,
    LEGACY_TOP_BAR_MARKER,
    "electron_1.app.on('web-contents-created', (_event, contents) => {",
    '    if ((0, scriptJail_1.isScriptJailSession)(contents.session) ||',
    '        (0, remoteWindowSecurity_1.isRemoteSession)(contents.session)) {',
    '        return;',
    '    }',
    "    contents.on('dom-ready', () => {",
    '        const url = contents.getURL();',
    "        if (url.startsWith('https://127.0.0.1:') || url.startsWith('http://127.0.0.1:')) {",
    '            void contents',
    "                .insertCSS('.agy-shell > div.shrink-0{display:none!important;}', { cssOrigin: 'user' })",
    '                .catch(() => undefined);',
    '        }',
    '    });',
    '});',
    TOP_BAR_PATCH_END,
  ].join('\n');
}

/** Strip any marker-wrapped agy-top-bar-patch block from dist/main.js source. */
export function stripTopBarPatch(source) {
  const startIdx = source.indexOf(TOP_BAR_PATCH_START);
  const endIdx = source.indexOf(TOP_BAR_PATCH_END);
  if (startIdx === -1 && endIdx === -1) return source;
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error('Corrupt agy-top-bar-patch marker block in dist/main.js');
  }
  const before = source.slice(0, startIdx).replace(/\n+$/, '');
  const after = source.slice(endIdx + TOP_BAR_PATCH_END.length).replace(/^\n+/, '');
  return after ? `${before}\n${after}` : `${before}\n`;
}

/** Return dist/main.js source with the hide-top-bar patch cleanly applied (idempotent). */
export function applyTopBarPatchToSource(source) {
  const hasMarkers = source.includes(TOP_BAR_PATCH_START) || source.includes(TOP_BAR_PATCH_END);
  const clean = hasMarkers ? stripTopBarPatch(source) : source;
  if (clean.includes(LEGACY_TOP_BAR_MARKER)) {
    return clean;
  }
  if (!clean.includes(TOP_BAR_ANCHOR)) {
    throw new Error('Anchor not found in dist/main.js: upstream layout changed, re-derive hide-top-bar patch');
  }
  return clean.replace(TOP_BAR_ANCHOR, `${TOP_BAR_ANCHOR}\n${renderTopBarSnippet()}`);
}
