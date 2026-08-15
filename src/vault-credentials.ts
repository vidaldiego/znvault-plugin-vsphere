import type { CLIPluginContext } from './plugin-types.js';
import type { RunFn } from './run.js';

export const DEFAULT_VCENTER_CREDENTIAL_ALIAS = 'infra/vsphere/leganes/vcenter';

interface SecretMetadata {
  id: string;
  alias: string;
  type: string;
}

interface DecryptedSecret extends SecretMetadata {
  data: Record<string, unknown>;
}

export interface VcenterCredential {
  alias: string;
  url: string;
  username: string;
  password: string;
  insecure: boolean;
}

export interface BoundVcenterRun {
  run: RunFn;
  endpoint: string;
  credentialAlias: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Vault vCenter credential is missing '${field}'`);
  }
  return value;
}

function parseInsecure(value: unknown): boolean {
  if (value === undefined || value === false || value === '0' || value === 'false') return false;
  if (value === true || value === '1' || value === 'true') return true;
  throw new Error("Vault vCenter credential field 'insecure' must be boolean");
}

function validateUrl(value: unknown): string {
  const url = requireNonEmptyString(value, 'url');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Vault vCenter credential field 'url' is invalid");
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw new Error("Vault vCenter credential field 'url' must be an HTTPS URL without credentials");
  }
  return url.replace(/\/$/, '');
}

export async function readVcenterCredential(
  ctx: CLIPluginContext,
  alias: string = DEFAULT_VCENTER_CREDENTIAL_ALIAS,
): Promise<VcenterCredential> {
  if (typeof alias !== 'string' || alias.trim() === '' || alias.startsWith('alias:')) {
    throw new Error('vCenter credential alias is invalid');
  }

  const metadata = await ctx.client.get<SecretMetadata>(
    `/v1/secrets/alias/${encodeURIComponent(alias)}`,
  );
  if (
    typeof metadata?.id !== 'string' ||
    metadata.id === '' ||
    metadata.alias !== alias ||
    metadata.type !== 'credential'
  ) {
    throw new Error(`Vault secret '${alias}' is not the expected credential`);
  }

  const secret = await ctx.client.post<DecryptedSecret>(
    `/v1/secrets/${encodeURIComponent(metadata.id)}/decrypt?resolve=false`,
    {},
  );
  if (
    secret?.id !== metadata.id ||
    secret.alias !== alias ||
    secret.type !== 'credential' ||
    secret.data === null ||
    typeof secret.data !== 'object' ||
    Array.isArray(secret.data)
  ) {
    throw new Error(`Vault secret '${alias}' changed while resolving it`);
  }

  return {
    alias,
    url: validateUrl(secret.data.url),
    username: requireNonEmptyString(secret.data.username, 'username'),
    password: requireNonEmptyString(secret.data.password, 'password'),
    insecure: parseInsecure(secret.data.insecure),
  };
}

export function bindGovcCredential(run: RunFn, credential: VcenterCredential): RunFn {
  const govcEnv = {
    GOVC_URL: credential.url,
    GOVC_USERNAME: credential.username,
    GOVC_PASSWORD: credential.password,
    GOVC_INSECURE: credential.insecure ? '1' : '0',
  };

  return (cmd, args, opts) => {
    if (cmd !== 'govc') return run(cmd, args, opts);
    return run(cmd, args, { ...opts, env: { ...opts?.env, ...govcEnv } });
  };
}

export async function resolveVcenterRun(
  ctx: CLIPluginContext,
  run: RunFn,
  alias: string = DEFAULT_VCENTER_CREDENTIAL_ALIAS,
): Promise<BoundVcenterRun> {
  const credential = await readVcenterCredential(ctx, alias);
  return {
    run: bindGovcCredential(run, credential),
    endpoint: credential.url,
    credentialAlias: credential.alias,
  };
}
