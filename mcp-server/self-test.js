'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { searchWorkspace, normalizeSnippet } = require('./search');

const PLUGIN_ROOT = path.resolve(__dirname, '..');


function assert(cond, message) {
  if (!cond) throw new Error(message);
}


function writeFixture(root, rel, contents) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, 'utf8');
  return abs;
}


async function testSearch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-jump-links-'));
  try {
    writeFixture(root, 'src/video.py', [
      'from pathlib import Path',
      'from typing import List',
      '',
      'class Parser:',
      '    def parse_video_folder(cls, folder_path: Path, video_extensions: List[str] = [\'.mp4\', \'.avi\']) -> None:',
      '        return None',
      '',
      'def other():',
      '    pass',
      '',
    ].join('\n'));
    writeFixture(root, 'src/app.ts', [
      'export function foo() {',
      '  return 1;',
      '}',
      '',
    ].join('\n'));
    writeFixture(root, 'tests/test_video.py', [
      'def parse_video_folder(cls, folder_path):',
      '    pass',
      '',
    ].join('\n'));

    const unique = await searchWorkspace({
      snippet: '    def parse_video_folder(cls, folder_path: Path, video_extensions: List[str] = [\'.mp4\', \'.avi\']) -> None:',
      workspace_roots: [root],
      hint_path: 'src/video.py',
      hint_symbol: 'parse_video_folder',
    });
    assert(unique.best, 'expected a best match for unique snippet');
    assert(unique.best.startLine === 5, `expected line 5, got ${unique.best.startLine}`);
    assert(unique.best.filepath.endsWith('src/video.py'), `unexpected filepath ${unique.best.filepath}`);
    assert(unique.best.citation_fence_header === `${unique.best.startLine}:${unique.best.endLine}:${unique.best.filepath}`, 'header mismatch');
    assert(unique.best.score >= 0.8, `score too low: ${unique.best.score}`);

    const lines = normalizeSnippet('def foo():\n    // ... existing code ...\n    return 1\n');
    assert(lines.length === 2, `ellipsis should drop, got ${JSON.stringify(lines)}`);

    const ts = await searchWorkspace({
      snippet: 'export function foo() {',
      workspace_roots: [root],
    });
    assert(ts.best && ts.best.filepath.endsWith('src/app.ts'), 'ts match failed');
    assert(ts.best.startLine === 1, 'ts line should be 1');

    const missing = await searchWorkspace({
      snippet: 'this_symbol_does_not_exist_zzqpx91',
      workspace_roots: [root],
    });
    assert(!missing.best, 'missing snippet should not invent a match');

    const emptyRoots = await searchWorkspace({
      snippet: 'export function foo() {',
      workspace_roots: [path.join(root, 'does-not-exist')],
      pluginRoot: PLUGIN_ROOT,
    });
    assert(emptyRoots.error, 'expected error when provided workspace roots are invalid');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}


function encodeContentLength(obj) {
  const json = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}


function parseFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    while (offset < buf.length) {
      const b = buf[offset];
      if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) {
        offset += 1;
        continue;
      }
      break;
    }
    if (offset >= buf.length) break;
    const head = buf.slice(offset, Math.min(buf.length, offset + 16)).toString('ascii');
    if (/^Content-Length\s*:/i.test(head)) {
      const rest = buf.slice(offset);
      const sepCrlf = rest.indexOf('\r\n\r\n');
      const sepLf = rest.indexOf('\n\n');
      let sep = -1;
      let sepLen = 0;
      if (sepCrlf !== -1 && (sepLf === -1 || sepCrlf <= sepLf)) {
        sep = sepCrlf;
        sepLen = 4;
      } else if (sepLf !== -1) {
        sep = sepLf;
        sepLen = 2;
      }
      if (sep === -1) break;
      const headers = rest.slice(0, sep).toString('ascii');
      const match = headers.match(/Content-Length\s*:\s*(\d+)/i);
      if (!match) break;
      const len = Number(match[1]);
      const bodyStart = offset + sep + sepLen;
      if (bodyStart + len > buf.length) break;
      frames.push(JSON.parse(buf.slice(bodyStart, bodyStart + len).toString('utf8')));
      offset = bodyStart + len;
    } else {
      const rest = buf.slice(offset);
      const nl = rest.indexOf('\n');
      if (nl === -1) break;
      const line = rest.slice(0, nl).toString('utf8').trim();
      if (line && line.startsWith('{')) frames.push(JSON.parse(line));
      offset += nl + 1;
    }
  }
  return frames;
}


async function testMcpHandshake() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-jump-links-mcp-'));
  writeFixture(fixture, 'lib/jumpme.py', 'def jump_me_unique_token_zzqpx():\n    return 1\n');

  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CHAT_JUMP_LINKS_PLUGIN_ROOT: PLUGIN_ROOT },
    windowsHide: true,
  });

  let stdout = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => {
    stdout = Buffer.concat([stdout, chunk]);
  });

  const send = (obj) => child.stdin.write(encodeContentLength(obj));
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'self-test' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'resolve_code_jump',
      arguments: {
        snippet: 'def jump_me_unique_token_zzqpx():',
        workspace_roots: [fixture],
      },
    },
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MCP handshake timed out'));
    }, 4000);
    const check = () => {
      const frames = parseFrames(stdout);
      if (frames.some((f) => f.id === 3)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', check);
    child.on('error', reject);
  });

  child.stdin.end();
  try { child.kill(); } catch { /* ignore */ }
  fs.rmSync(fixture, { recursive: true, force: true });

  const frames = parseFrames(stdout);
  const init = frames.find((f) => f.id === 1);
  const listed = frames.find((f) => f.id === 2);
  const called = frames.find((f) => f.id === 3);
  assert(init && init.result && init.result.serverInfo.name === 'chat-jump-links', 'initialize failed');
  assert(listed && listed.result.tools[0].name === 'resolve_code_jump', 'tools/list failed');
  assert(called && called.result && called.result.structuredContent && called.result.structuredContent.best, 'tools/call did not return best');
  assert(called.result.structuredContent.best.filepath.endsWith('lib/jumpme.py'), 'MCP search missed fixture');
}


async function run() {
  await testSearch();
  await testMcpHandshake();
  process.stderr.write('chat-jump-links self-test passed\n');
  return 0;
}


module.exports = { run };

if (require.main === module) {
  run().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
    process.exit(1);
  });
}
