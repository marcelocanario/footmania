import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { gameConfig } from "../config";

const locks = new Map<number, Promise<unknown>>();
let globalLock: Promise<unknown> = Promise.resolve();

const GLOBAL_LEASE_KEY = "__SCHEDULER_GLOBAL_LEASE__";

export interface GlobalLease {
  owner: string;
  value: string;
}

export function withSaveLock<T>(saveId: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(saveId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    saveId,
    next.catch(() => {})
  );
  return next;
}

/** Serialize all global-world mutations through one lock. */
export function withGlobalLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = globalLock.then(fn, fn);
  globalLock = next.catch(() => {});
  return next;
}

/**
 * Acquire a database-backed lease in addition to the process-local mutex. The
 * compare-and-swap update prevents two backend instances from mutating the
 * global world concurrently; an expired lease is recoverable after a crash.
 */
export async function acquireGlobalLease(prisma: PrismaClient, now = new Date()): Promise<GlobalLease> {
  const owner = `${process.pid}:${randomUUID()}`;
  const expiresAt = now.getTime() + gameConfig.scheduler.leaseSeconds * 1000;
  const value = `${owner}|${expiresAt}`;
  const existing = await prisma.setting.findUnique({ where: { key: GLOBAL_LEASE_KEY } });
  if (!existing) {
    try {
      await prisma.setting.create({ data: { key: GLOBAL_LEASE_KEY, value } });
      return { owner, value };
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      return acquireGlobalLease(prisma, now);
    }
  }
  const separator = existing.value.lastIndexOf("|");
  const existingExpiry = separator >= 0 ? Number(existing.value.slice(separator + 1)) : 0;
  if (Number.isFinite(existingExpiry) && existingExpiry > now.getTime()) {
    throw new Error("Global scheduler lease is held by another process");
  }
  const claimed = await prisma.setting.updateMany({ where: { key: GLOBAL_LEASE_KEY, value: existing.value }, data: { value } });
  if (claimed.count !== 1) throw new Error("Global scheduler lease was claimed concurrently");
  return { owner, value };
}

export async function renewGlobalLease(prisma: PrismaClient, lease: GlobalLease, now = new Date()): Promise<void> {
  const expiresAt = now.getTime() + gameConfig.scheduler.leaseSeconds * 1000;
  const value = `${lease.owner}|${expiresAt}`;
  const renewed = await prisma.setting.updateMany({ where: { key: GLOBAL_LEASE_KEY, value: lease.value }, data: { value } });
  if (renewed.count !== 1) throw new Error("Global scheduler lease was lost");
  lease.value = value;
}

/** Keep a lease alive while a durable operation performs multiple writes. */
export async function withGlobalLease<T>(prisma: PrismaClient, fn: (lease: GlobalLease) => Promise<T>, now = new Date()): Promise<T> {
  const lease = await acquireGlobalLease(prisma, now);
  let renewal: Promise<void> | null = null;
  const interval = setInterval(() => {
    if (renewal) return;
    renewal = renewGlobalLease(prisma, lease).finally(() => { renewal = null; });
    void renewal.catch(() => undefined);
  }, Math.max(1000, Math.floor(gameConfig.scheduler.leaseSeconds * 1000 / 3)));
  try {
    return await fn(lease);
  } finally {
    clearInterval(interval);
    await Promise.resolve(renewal).catch(() => undefined);
    await releaseGlobalLease(prisma, lease);
  }
}

export async function releaseGlobalLease(prisma: PrismaClient, lease: GlobalLease): Promise<void> {
  await prisma.setting.updateMany({ where: { key: GLOBAL_LEASE_KEY, value: lease.value }, data: { value: `${lease.owner}|0` } });
}
