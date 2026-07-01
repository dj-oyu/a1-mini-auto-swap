// Pre-generate the stub's self-signed TLS material into ./certs.
// Optional: the stub also mints these on first boot (src/stub/tls.ts). Run
// `bun run certs` if you want them created ahead of time or in CI setup.
import { join } from "node:path";
import { ensureCerts } from "../src/stub/tls.ts";

const dir = process.env.STUB_CERT_DIR ?? join(process.cwd(), "certs");
ensureCerts(dir);
console.log(`TLS material ready in ${dir} (key.pem, cert.pem)`);
