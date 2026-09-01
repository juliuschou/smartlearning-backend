import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const compose = readFileSync(resolve(root, 'docker-compose.cp8.yml'), 'utf8');
const nginx = readFileSync(resolve(root, 'ops/topology/nginx.conf'), 'utf8');
const handoff = readFileSync(resolve(root, 'ops/topology/README.md'), 'utf8');

describe('CP8 verification topology contract', () => {
  it('uses an isolated two-instance compiled backend topology', () => {
    expect(compose).toContain('target: runtime');
    expect(compose).toContain('api-a:');
    expect(compose).toContain('api-b:');
    expect(compose).toContain('condition: service_completed_successfully');
    expect(compose).toContain('TRUST_PROXY_HOPS: 1');
    expect(compose).toContain('REALTIME_REDIS_MODE: required');
    expect(compose).toContain('REDIS_URL: redis://redis-realtime:6379/0');
    expect(compose).toContain(
      'LOGIN_RATE_LIMIT_REDIS_URL: redis://redis-login:6379/0',
    );
    expect(compose).toContain("'127.0.0.1:${CP8_HTTPS_PORT:-8443}:443'");
    expect(compose).toContain('internal: true');
    expect(compose).not.toMatch(/container_name:/u);
  });

  it('keeps proxy controls and metrics policy explicit', () => {
    expect(nginx).toContain('proxy_set_header X-Forwarded-Proto https;');
    expect(nginx).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    expect(nginx).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(nginx).toContain('proxy_read_timeout 75s;');
    expect(nginx).toContain('client_max_body_size 1m;');
    expect(nginx).toContain('location = /metrics {');
    expect(nginx).toContain('return 404;');
    expect(nginx).toContain("proxy_set_header X-Account-Id '';");
  });

  it('documents scope, authority, failure drills, and ownership', () => {
    expect(handoff).toContain('verification-only');
    expect(handoff).toContain('PostgreSQL remains domain authority');
    expect(handoff).toContain('SERVER_SHUTTING_DOWN');
    expect(handoff).toContain('W1–W8');
    expect(handoff).toContain('OPS-1');
    expect(handoff).toContain('OPS-2');
  });
});
