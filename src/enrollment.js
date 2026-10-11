import fs from 'node:fs';
import path from 'node:path';
import { root } from './core.js';
import { atomicSecretWrite } from './private-file.js';

export function gatewayURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['/', '/api/public/agent-context'].includes(url.pathname.replace(/\/$/, '') || '/')) throw new Error('Unsupported gateway URL; HTTPS gateway required');
  return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/$/, ''));
}

export function enrollment() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root(), 'enrollment.json'), 'utf8'));
    gatewayURL(value.gateway);
    if (!/^[a-f0-9]{32}$/.test(value.device) || !/^acd_[a-f0-9]{64}$/.test(value.token) || !/^[a-zA-Z0-9-]{1,39}$/.test(value.user)) return null;
    return value;
  } catch { return null; }
}

// Device credentials work only at our gateway; they cannot authenticate with Langfuse itself.
export function deviceCredentials(value = enrollment()) {
  return value ? { public_key: 'pk-lf-device-' + value.device, secret_key: 'sk-lf-device-' + value.token } : null;
}

export async function connectGateway(origin, { request = fetch, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), announce = value => process.stdout.write(value + '\n') } = {}) {
  const gateway = gatewayURL(origin);
  announce('Agent Context sends selected tool context to the team compression service and conversation/tool telemetry to the team Langfuse. Agent login and approvals stay unchanged. Continue by approving the GitHub device sign-in.');
  const infoResponse = await request(gateway + '/v1/info', { signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!infoResponse.ok) throw new Error('Unsupported gateway configuration');
  const info = await infoResponse.json();
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(info.clientId) || !/^[a-zA-Z0-9-]{1,39}$/.test(info.organization)) throw new Error('Unsupported GitHub client ID');
  const github = async (route, body) => {
    const response = await request('https://github.com/login/' + route, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!response.ok) throw new Error('GitHub sign-in failed');
    return response.json();
  };
  const code = await github('device/code', { client_id: info.clientId, scope: 'read:org' });
  if (code.verification_uri !== 'https://github.com/login/device' || typeof code.device_code !== 'string' || !/^[A-Z0-9-]{4,32}$/.test(code.user_code) || !Number.isFinite(code.expires_in) || code.expires_in <= 0 || !Number.isFinite(code.interval) || code.interval < 1) throw new Error('GitHub sign-in failed');
  announce(`GitHub sign-in: ${code.verification_uri}\nCode: ${code.user_code}\nApprove Agent Context access for ${info.organization}. Service keys are not requested.`);
  const expires = Date.now() + Math.min(code.expires_in, 1800) * 1000;
  let interval = Math.max(5, code.interval);
  while (Date.now() < expires) {
    await pause(interval * 1000);
    const result = await github('oauth/access_token', { client_id: info.clientId, device_code: code.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (result.error === 'authorization_pending') continue;
    if (result.error === 'slow_down') { interval += 5; continue; }
    if (!result.access_token || result.error) throw new Error('GitHub sign-in denied or expired');
    const response = await request(gateway + '/v1/enroll', { method: 'POST', headers: { Authorization: 'Bearer ' + result.access_token, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw new Error('Gateway enrollment refused; check GitHub team membership');
    const value = await response.json();
    if (!/^[a-f0-9]{32}$/.test(value.device) || !/^acd_[a-f0-9]{64}$/.test(value.token) || !/^[a-zA-Z0-9-]{1,39}$/.test(value.user)) throw new Error('Unsupported enrollment response');
    atomicSecretWrite(path.join(root(), 'enrollment.json'), JSON.stringify({ gateway, device: value.device, token: value.token, user: value.user }, null, 2) + '\n');
    return { status: 'connected', gateway, device: value.device, user: value.user, nextSteps: ['agent-context setup', 'agent-context telemetry verify'] };
  }
  throw new Error('GitHub sign-in expired');
}
