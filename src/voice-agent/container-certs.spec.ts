// container-certs.spec.ts: the worker's LiveKit engine is Rust and reads the system trust store,
// which node:22-slim does not ship. Without ca-certificates in the image every job dies with
// "no native root CA certificates found" while the API keeps working on Node's bundled roots.
import { readFileSync } from 'fs';
import { join } from 'path';

describe('container CA certificates', () => {
  it('installs ca-certificates in the runtime stage', () => {
    const dockerfile = readFileSync(join(__dirname, '..', '..', 'Dockerfile'), 'utf8');
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('FROM '));

    expect(runtimeStage).toMatch(/apt-get install[^\n]*ca-certificates/);
  });
});
