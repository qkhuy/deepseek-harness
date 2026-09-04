import type { Context } from '@deepseek-ai/cordis'
import { PrincipalService, principalId } from '../src/index.ts'
import type { Principal, PrincipalRequest } from '../src/index.ts'

/** Seed for {@link MemoryPrincipals}: header token → the principal it names. */
export interface MemoryPrincipalsConfig {
  readonly tokens?: Record<string, Principal>
  readonly required?: boolean
}

/**
 * In-memory principal provider for seam and consumer tests: an
 * `x-test-principal` header names one seeded principal.
 */
export class MemoryPrincipals extends PrincipalService {
  private readonly tokens: Map<string, Principal>
  private readonly requiredFlag: boolean

  constructor(ctx: Context, config: MemoryPrincipalsConfig = {}) {
    super(ctx)
    this.tokens = new Map(Object.entries(config.tokens ?? {}))
    this.requiredFlag = config.required ?? false
  }

  override get required(): boolean {
    return this.requiredFlag
  }

  override authenticate(request: PrincipalRequest): Principal | undefined {
    const { headers } = request
    const raw = headers instanceof Headers
      ? headers.get('x-test-principal') ?? undefined
      : headers['x-test-principal']
    return typeof raw === 'string' ? this.tokens.get(raw) : undefined
  }
}

/**
 * Build one principal without restating every field at each call site.
 * @param id - raw principal id, branded here.
 * @param overrides - fields replacing the defaults.
 * @returns the principal.
 */
export function testPrincipal(id: string, overrides: Partial<Principal> = {}): Principal {
  return {
    id: principalId(id),
    displayName: id,
    secret: `sk-${id}`,
    models: [],
    ...overrides,
  }
}
