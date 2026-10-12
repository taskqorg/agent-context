// Qualification only: call the installed context-mode package, never register agent hooks.
import { readFileSync, copyFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const [root, corpus, storage] = process.argv.slice(2);
const resolve = createRequire(`${root}/package.json`).resolve;
const { Client } = await import(pathToFileURL(resolve('@modelcontextprotocol/sdk/client/index.js')));
const { StdioClientTransport } = await import(pathToFileURL(resolve('@modelcontextprotocol/sdk/client/stdio.js')));
const transport = new StdioClientTransport({
  command: process.execPath, args: [`${root}/server.bundle.mjs`], stderr: 'pipe',
  env: { PATH: process.env.PATH, CONTEXT_MODE_DIR: storage, CONTEXT_MODE_PLATFORM: 'claude-code',
    CONTEXT_MODE_PROJECT_DIR: process.cwd(), DO_NOT_TRACK: '1' },
});
const client = new Client({ name: 'context-options-qualification', version: '1.0.0' });
const started = performance.now();
const textOf = r => (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
try {
  await client.connect(transport);
  const startup_ms = performance.now() - started;
  const tools = await client.listTools();
  const results = [];
  for (const f of JSON.parse(readFileSync(corpus, 'utf8'))) {
    for (let repeat = 0; repeat < 3; repeat++) {
      const begin = performance.now();
      // Existing sandbox recipe: data stays in FILE_CONTENT; only printed output enters context.
      const path = `${f.path}.${repeat}`;
      copyFileSync(f.path, path);
      const args = { path, language: 'javascript', code: 'console.log(FILE_CONTENT)', timeout: 5000, intent: f.query };
      let response;
      const outputs = [];
      let retrieval_ok = false;
      if (f.kind === 'docs') {
        // Use the documented index/search recipe for reference documents.
        const indexed = await client.callTool({ name: 'ctx_index', arguments: { path, source: `${f.id}-${repeat}` } });
        const searched = await client.callTool({ name: 'ctx_search', arguments: { queries: [f.query], source: `${f.id}-${repeat}`, limit: 3 } });
        outputs.push(textOf(indexed), textOf(searched));
        response = searched;
      } else {
        response = await client.callTool({ name: 'ctx_execute_file', arguments: args }, undefined, { timeout: 10000 });
        outputs.push(textOf(response));
        if (textOf(response).includes('Use ctx_search')) {
          const searched = await client.callTool({ name: 'ctx_search', arguments: {
            queries: [f.query], source: `file:${path}`, limit: 3,
          } });
          outputs.push(textOf(searched));
          response = searched;
        }
      }
      const elapsed_ms = performance.now() - begin;
      // Exact recovery proof is separate from first-response savings.
      const original = readFileSync(f.path, 'utf8');
      const recovery = [];
      retrieval_ok = true;
      for (let offset = 0; offset < original.length; offset += 3000) {
        const recovered = await client.callTool({ name: 'ctx_execute_file', arguments: {
          path, language: 'javascript',
          code: `console.log(JSON.stringify(FILE_CONTENT.slice(${offset}, ${offset + 3000})))`, timeout: 5000,
        } });
        recovery.push(textOf(recovered));
        retrieval_ok &&= !recovered.isError && textOf(recovered).includes(JSON.stringify(original.slice(offset, offset + 3000)));
      }
      results.push({ fixture: f.id, repeat, elapsed_ms, output: outputs.join('\n'),
        request_text: JSON.stringify(args), recovery_response: recovery.join('\n'),
        recovery_ok: retrieval_ok, error: Boolean(response.isError) });
    }
  }
  process.stdout.write(JSON.stringify({ startup_ms, tool_schema: JSON.stringify(tools), results }));
} finally { await client.close(); }
