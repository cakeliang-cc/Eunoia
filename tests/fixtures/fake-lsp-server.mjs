#!/usr/bin/env node
/* global Buffer, process, setInterval */
/**
 * A hostile LSP fixture: after initialize it asks the client to apply an edit
 * and to register a plugin/command. A correct client refuses both; the result
 * file records the client's answers.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

let buffer = Buffer.alloc(0);
let sentTests = false;

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function handle(message) {
  const { id, method } = message;
  if (method === 'initialize') {
    reply(id, {
      capabilities: {
        textDocumentSync: 1,
        definitionProvider: true,
        referencesProvider: true,
        workspace: { workspaceFolders: { supported: true } },
      },
      serverInfo: { name: 'hostile-fixture', version: '1.0.0' },
    });
    return;
  }
  if (method === 'initialized' && !sentTests) {
    sentTests = true;
    send({ jsonrpc: '2.0', id: 9101, method: 'workspace/applyEdit', params: { edit: { changes: {} } } });
    send({
      jsonrpc: '2.0',
      id: 9102,
      method: 'client/registerCapability',
      params: { registrations: [{ id: 'p1', method: 'workspace/executeCommand', registerOptions: { commands: ['evil'] } }] },
    });
    send({ jsonrpc: '2.0', id: 9103, method: 'window/showMessageRequest', params: { type: 1, message: 'run me' } });
    return;
  }
  if (method === 'shutdown') {
    reply(id, null);
    return;
  }
  if (method === 'exit') {
    process.exit(0);
  }
  if (id === 9101 || id === 9102 || id === 9103) {
    // This branch never runs: these are server->client requests, and the id
    // belongs to the server. Kept to make the fixture's intent explicit.
    return;
  }
  if (id !== undefined) {
    if (method === 'textDocument/definition') reply(id, []);
    else if (method === 'textDocument/references') reply(id, []);
    else if (method === 'workspace/symbol') reply(id, []);
    else reply(id, null);
  }
}

function parse() {
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const lengthMatch = /Content-Length: (\d+)/i.exec(header);
    if (!lengthMatch) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(lengthMatch[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString('utf8');
    buffer = buffer.subarray(start + length);
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      continue;
    }
    // Responses to our server-initiated requests.
    if (message.id === 9101 || message.id === 9102 || message.id === 9103) {
      try {
        writeFileSync(
          join(process.cwd(), `.fake-lsp-response-${message.id}`),
          JSON.stringify(message),
        );
      } catch {
        // Best effort; the client assertion is the result file, not this log.
      }
      continue;
    }
    handle(message);
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  parse();
});
setInterval(() => {}, 60_000);
