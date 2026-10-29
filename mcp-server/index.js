'use strict';

const { searchWorkspace, formatCitationText } = require('./search');

const SERVER_INFO = { name: 'chat-jump-links', version: '1.0.0' };
const PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const DEFAULT_PROTOCOL = '2024-11-05';

const TOOL_NAME = 'resolve_code_jump';
const TOOL_DESCRIPTION = [
  'Resolve a code snippet to the most likely workspace file and line range, then return a clickable Cursor citation fence header (startLine:endLine:filepath).',
  'Use when citing existing workspace code without a verified filepath and line range, when the model paraphrased or omitted a path, when the user wants to jump/open/find that code, or for /jump-to-code.',
  'Do not use for brand-new proposed code that is not in the repo.',
].join(' ');

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    snippet: {
      type: 'string',
      description: 'Literal code text, 1-8 lines, unique-ish. Strip "... existing code ..." placeholders.',
    },
    workspace_roots: {
      type: 'array',
      items: { type: 'string' },
      description: 'Absolute workspace folder paths from this session. Required if MCP roots are unavailable.',
    },
    hint_path: {
      type: 'string',
      description: 'File, directory, or glob the model guessed.',
    },
    hint_symbol: {
      type: 'string',
      description: 'Function, class, or identifier name.',
    },
    glob: {
      type: 'string',
      description: 'ripgrep glob such as *.py or *.{ts,tsx}. Inferred from the snippet when omitted.',
    },
    max_results: {
      type: 'integer',
      description: 'Maximum ranked matches to return (default 5, cap 20).',
    },
  },
  required: ['snippet'],
};

const TOOL_DEF = {
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  inputSchema: TOOL_SCHEMA,
};

let useContentLength = true;
let mcpRoots = [];
let nextServerId = 1;
const pendingServerRequests = new Map();


function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}


function writeMessage(obj) {
  const json = JSON.stringify(obj);
  if (useContentLength) {
    process.stdout.write(`Content-Length: ${byteLength(json)}\r\n\r\n${json}`);
  } else {
    process.stdout.write(json + '\n');
  }
}


function sendResult(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}


function sendError(id, code, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}


function requestRootsList() {
  const id = `s-${nextServerId++}`;
  pendingServerRequests.set(id, (msg) => {
    const roots = (msg.result && msg.result.roots) || [];
    mcpRoots = Array.isArray(roots) ? roots : [];
  });
  writeMessage({ jsonrpc: '2.0', id, method: 'roots/list' });
}


function handleInitialize(id, params) {
  const requested = params && params.protocolVersion;
  const protocolVersion = PROTOCOL_VERSIONS.has(requested) ? requested : DEFAULT_PROTOCOL;
  const clientRoots = params && params.capabilities && params.capabilities.roots;
  sendResult(id, {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
  });
  handleInitialize._wantRoots = Boolean(clientRoots);
}


function handleInitialized() {
  if (handleInitialize._wantRoots) requestRootsList();
}


async function handleToolsCall(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  if (name !== TOOL_NAME) {
    sendError(id, -32601, `Unknown tool: ${name}`);
    return;
  }
  try {
    const result = await searchWorkspace({
      snippet: args.snippet,
      workspace_roots: args.workspace_roots,
      hint_path: args.hint_path,
      hint_symbol: args.hint_symbol,
      glob: args.glob,
      max_results: args.max_results,
      mcpRoots,
      pluginRoot: process.env.CHAT_JUMP_LINKS_PLUGIN_ROOT || '',
    });
    const text = result.error
      ? `Error: ${result.error}`
      : formatCitationText(result);
    sendResult(id, {
      content: [{ type: 'text', text }],
      structuredContent: result,
      isError: Boolean(result.error) || !result.best,
    });
  } catch (err) {
    sendResult(id, {
      content: [{ type: 'text', text: `Error: ${err && err.message ? err.message : String(err)}` }],
      isError: true,
    });
  }
}


function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  if (Object.prototype.hasOwnProperty.call(msg, 'id') && !msg.method && pendingServerRequests.has(msg.id)) {
    const cb = pendingServerRequests.get(msg.id);
    pendingServerRequests.delete(msg.id);
    cb(msg);
    return;
  }

  const method = msg.method;
  const id = msg.id;
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    handleInitialize(id, msg.params || {});
    return;
  }
  if (method === 'notifications/initialized') {
    handleInitialized();
    return;
  }
  if (method === 'notifications/cancelled' || method === 'notifications/roots/list_changed') {
    if (method === 'notifications/roots/list_changed') requestRootsList();
    return;
  }
  if (method === 'ping') {
    if (!isNotification) sendResult(id, {});
    return;
  }
  if (method === 'tools/list') {
    sendResult(id, { tools: [TOOL_DEF] });
    return;
  }
  if (method === 'tools/call') {
    handleToolsCall(id, msg.params || {});
    return;
  }
  if (isNotification) return;
  if (method) sendError(id, -32601, `Method not found: ${method}`);
}


function createStdioReader(onMessage) {
  let buf = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (buf.length) {
      const parsed = tryReadMessage(buf);
      if (!parsed) break;
      buf = parsed.rest;
      if (parsed.framing === 'content-length') useContentLength = true;
      if (parsed.framing === 'newline') useContentLength = false;
      onMessage(parsed.value);
    }
  });
}


function skipAsciiSpace(buf, start) {
  let i = start;
  while (i < buf.length) {
    const b = buf[i];
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}


function indexOfBytes(buf, start, bytes) {
  const first = bytes[0];
  outer: for (let i = start; i <= buf.length - bytes.length; i += 1) {
    if (buf[i] !== first) continue;
    for (let j = 1; j < bytes.length; j += 1) {
      if (buf[i + j] !== bytes[j]) continue outer;
    }
    return i;
  }
  return -1;
}


function tryReadMessage(buf) {
  const start = skipAsciiSpace(buf, 0);
  if (start >= buf.length) return null;
  const head = buf.slice(start, Math.min(buf.length, start + 16)).toString('ascii');

  if (/^Content-Length\s*:/i.test(head)) {
    const sepCrlf = indexOfBytes(buf, start, Buffer.from('\r\n\r\n'));
    const sepLf = indexOfBytes(buf, start, Buffer.from('\n\n'));
    let sep = -1;
    let sepLen = 0;
    if (sepCrlf !== -1 && (sepLf === -1 || sepCrlf <= sepLf)) {
      sep = sepCrlf;
      sepLen = 4;
    } else if (sepLf !== -1) {
      sep = sepLf;
      sepLen = 2;
    }
    if (sep === -1) return null;
    const headers = buf.slice(start, sep).toString('ascii');
    const match = headers.match(/Content-Length\s*:\s*(\d+)/i);
    const bodyStart = sep + sepLen;
    if (!match) return { rest: buf.slice(bodyStart), value: null, framing: 'content-length' };
    const len = Number(match[1]);
    if (buf.length < bodyStart + len) return null;
    const body = buf.slice(bodyStart, bodyStart + len).toString('utf8');
    let value = null;
    try { value = JSON.parse(body); } catch { value = null; }
    return { rest: buf.slice(bodyStart + len), value, framing: 'content-length' };
  }

  const nl = indexOfBytes(buf, start, Buffer.from('\n'));
  if (nl === -1) return null;
  const line = buf.slice(start, nl).toString('utf8').replace(/\r$/, '');
  const rest = buf.slice(nl + 1);
  if (!line.trim()) return { rest, value: null, framing: 'newline' };
  let value = null;
  try { value = JSON.parse(line); } catch { value = null; }
  return { rest, value, framing: 'newline' };
}


function serveStdio() {
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  createStdioReader((msg) => {
    if (msg) handleMessage(msg);
  });
  process.stdin.on('end', () => process.exit(0));
  process.stderr.write('chat-jump-links MCP server listening on stdio\n');
}


if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--self-test') {
    require('./self-test').run().then((code) => process.exit(code)).catch((err) => {
      process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
      process.exit(1);
    });
  } else {
    serveStdio();
  }
}

module.exports = {
  TOOL_DEF,
  handleMessage,
  serveStdio,
  writeMessage,
};
