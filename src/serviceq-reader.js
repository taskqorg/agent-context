// Metadata-only reads shared by the guarded UI and the operator's JSON report.
export async function readServiceq(base, authorization, now, period, fetcher = fetch) {
  const queries = [
    ['health', { filter: JSON.stringify([{ type: 'string', column: 'name', operator: 'starts with', value: 'service.health.' }]) }, 86400],
    ['compression', { name: 'agent-context.compression' }, period],
    ['nativeTools', { name: 'agent-context.native-tool' }, period],
    ['activity', { type: 'GENERATION' }, period],
    ['incidents', { name: 'service.incident' }, 86400]
  ];
  const results = await Promise.all(queries.map(async ([key, query, seconds]) => {
    const rows = [], cursors = new Set(), deadline = Date.now() + 45000;
    let cursor;
    do {
      const url = new URL('/api/public/v2/observations', base);
      for (const [key, value] of Object.entries({ ...query, fields: query.type === 'GENERATION' ? 'core,basic,trace_context,metadata,model,usage' : 'core,basic,trace_context,metadata', fromStartTime: new Date(now - seconds * 1000).toISOString(), toStartTime: new Date(now).toISOString(), limit: Math.min(1000, 10000 - rows.length), ...(cursor ? { cursor } : {}) })) url.searchParams.set(key, value);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Langfuse read deadline');
      const response = await fetcher(url, { headers: { Authorization: authorization }, redirect: 'error', signal: AbortSignal.timeout(Math.min(12000, remaining)) });
      if (!response.ok) throw new Error('Langfuse read failed');
      const body = await response.json();
      if (!Array.isArray(body.data)) throw new Error('Invalid Langfuse response');
      rows.push(...body.data.slice(0, 10000 - rows.length));
      cursor = body.meta?.cursor || body.meta?.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Repeated Langfuse cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor && rows.length < 10000);
    return { key, rows, truncated: Boolean(cursor) };
  }));
  return { ...Object.fromEntries(results.map(r => [r.key, r.rows])), truncated: results.filter(r => r.truncated).map(r => r.key) };
}
