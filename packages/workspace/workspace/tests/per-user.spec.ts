/**
 * Per-user workspace separation: with a signed-in user bound, the registry
 * shows that user their own workspaces and nobody else's.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { PrincipalService, principalId } from '@deepseek-ai/dsh-principal'
import type { Principal, PrincipalRequest } from '@deepseek-ai/dsh-principal'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceRegistry from '../src/index.ts'

/** A principal seam the test binds directly; requests never reach it here. */
class TestPrincipals extends PrincipalService {
  override get required(): boolean { return true }
  override authenticate(_request: PrincipalRequest): Principal | undefined { return undefined }
}

const user = (id: string): Principal => ({
  id: principalId(id), displayName: id, secret: `sk-${id}`, models: [],
})

const alice = user('alice')
const bob = user('bob')

let roots: string[] = []
let contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts = []
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots = []
})

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-user-'))
  roots.push(root)
  return root
}

/** Boot the registry with a principal seam mounted, over one shared medium. */
async function harness(pool = new MemoryMediaPool(), withPrincipal = true): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('sessionPersistence', { list: vi.fn(async () => []) } as never)
  if (withPrincipal) await ctx.plugin(TestPrincipals)
  await ctx.plugin(WorkspaceRegistry)
  return ctx
}

describe('workspaces created by a signed-in user', () => {
  it('are stamped with that user and listed only for them', async () => {
    const ctx = await harness()
    const path = await directory()
    const created = await ctx.principal.run(alice, async () => await ctx.workspaceRegistry.create(path))
    expect(created.owner).toBe('alice')
    expect(ctx.principal.run(alice, () => ctx.workspaceRegistry.list()).map(entry => entry.id)).toEqual([created.id])
    expect(ctx.principal.run(bob, () => ctx.workspaceRegistry.list())).toEqual([])
  })

  it('cannot be read by id from another user', async () => {
    const ctx = await harness()
    const created = await ctx.principal.run(alice, async () => await ctx.workspaceRegistry.create(await directory()))
    expect(ctx.principal.run(alice, () => ctx.workspaceRegistry.get(created.id))?.id).toBe(created.id)
    expect(ctx.principal.run(bob, () => ctx.workspaceRegistry.get(created.id))).toBeUndefined()
  })

  it('cannot be found by path from another user', async () => {
    const ctx = await harness()
    const path = await directory()
    await ctx.principal.run(alice, async () => await ctx.workspaceRegistry.create(path))
    expect(await ctx.principal.run(alice, async () => await ctx.workspaceRegistry.resolveByPath(path))).toBeDefined()
    expect(await ctx.principal.run(bob, async () => await ctx.workspaceRegistry.resolveByPath(path))).toBeUndefined()
  })

  it('give each user their own registration for one shared directory', async () => {
    const ctx = await harness()
    const path = await directory()
    const forAlice = await ctx.principal.run(alice, async () => await ctx.workspaceRegistry.create(path))
    const forBob = await ctx.principal.run(bob, async () => await ctx.workspaceRegistry.create(path))
    expect(forBob.id).not.toBe(forAlice.id)
    expect(forBob.owner).toBe('bob')
    expect(ctx.principal.run(alice, () => ctx.workspaceRegistry.list()).map(entry => entry.id)).toEqual([forAlice.id])
  })

  it('reuse one registration when the same user opens the directory again', async () => {
    const ctx = await harness()
    const path = await directory()
    const first = await ctx.principal.run(alice, async () => await ctx.workspaceRegistry.create(path))
    const second = await ctx.principal.run(alice, async () => await ctx.workspaceRegistry.create(path))
    expect(second.id).toBe(first.id)
  })

  it('cannot be deleted by another user, and stays intact', async () => {
    const ctx = await harness()
    const created = await ctx.principal.run(alice, async () => await ctx.workspaceRegistry.create(await directory()))
    expect(await ctx.principal.run(bob, async () => await ctx.workspaceRegistry.delete(created.id))).toBe(false)
    expect(ctx.principal.run(alice, () => ctx.workspaceRegistry.get(created.id))?.id).toBe(created.id)
  })

  it('can be deleted by its own owner', async () => {
    const ctx = await harness()
    const created = await ctx.principal.run(alice, async () => await ctx.workspaceRegistry.create(await directory()))
    expect(await ctx.principal.run(alice, async () => await ctx.workspaceRegistry.delete(created.id))).toBe(true)
    expect(ctx.principal.run(alice, () => ctx.workspaceRegistry.get(created.id))).toBeUndefined()
  })

  it('cannot be reordered by another user, as either the moved workspace or the anchor', async () => {
    const ctx = await harness()
    const owned = await ctx.principal.run(alice, async () => await ctx.workspaceRegistry.create(await directory()))
    const other = await ctx.principal.run(alice, async () => await ctx.workspaceRegistry.create(await directory()))
    await expect(ctx.principal.run(bob, async () => await ctx.workspaceRegistry.insertBefore(owned.id)))
      .rejects.toThrow()
    const bobOwn = await ctx.principal.run(bob, async () => await ctx.workspaceRegistry.create(await directory()))
    await expect(ctx.principal.run(bob, async () => await ctx.workspaceRegistry.insertBefore(bobOwn.id, other.id)))
      .rejects.toThrow()
  })

  it('survive a restart, still separated by owner', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const alicePath = await directory()
    const bobPath = await directory()
    await first.principal.run(alice, async () => await first.workspaceRegistry.create(alicePath))
    await first.principal.run(bob, async () => await first.workspaceRegistry.create(bobPath))
    await first.fiber.dispose()

    const restarted = await harness(pool)
    expect(restarted.principal.run(alice, () => restarted.workspaceRegistry.list()).map(entry => entry.path))
      .toEqual([alicePath])
    expect(restarted.principal.run(bob, () => restarted.workspaceRegistry.list()).map(entry => entry.path))
      .toEqual([bobPath])
  })
})

describe('workspaces with no owner', () => {
  it('stay unstamped and fully visible where no principal seam is mounted', async () => {
    const ctx = await harness(new MemoryMediaPool(), false)
    const created = await ctx.workspaceRegistry.create(await directory())
    expect(created.owner).toBeUndefined()
    expect(ctx.workspaceRegistry.list()).toHaveLength(1)
  })

  it('stay visible to unattended work once a seam is mounted', async () => {
    const pool = new MemoryMediaPool()
    const before = await harness(pool, false)
    await before.workspaceRegistry.create(await directory())
    await before.fiber.dispose()

    const after = await harness(pool)
    expect(after.workspaceRegistry.list()).toHaveLength(1)
  })

  it('are not handed to whoever signs in first', async () => {
    const pool = new MemoryMediaPool()
    const before = await harness(pool, false)
    await before.workspaceRegistry.create(await directory())
    await before.fiber.dispose()

    const after = await harness(pool)
    expect(after.principal.run(alice, () => after.workspaceRegistry.list())).toEqual([])
  })
})
