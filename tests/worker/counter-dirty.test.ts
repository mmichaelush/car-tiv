import { it, expect } from 'vitest';
import { createTestDatabase } from '../helpers/d1.js';
import { seedCatalog } from '../helpers/fixtures.js';
import { CountersRepository } from '@worker/repositories/counters-repository.js';
import { MaintenanceRepository } from '@worker/repositories/maintenance-repository.js';

it('skips unchanged catalog scans but refreshes after a status mutation', async () => {
  const db = await createTestDatabase();
  try {
    seedCatalog(db);
    const counters = new CountersRepository(db);
    await counters.refreshAll();
    const before = (await counters.readAll()).get('videos.live');
    db.runRaw('UPDATE videos SET last_checked_at = CURRENT_TIMESTAMP');
    const idle = await db.record(() => counters.refreshAll());
    expect(idle.some((s) => s.sql.includes('video_tags'))).toBe(false);
    db.runRaw("UPDATE videos SET status = 'hidden' WHERE id = 'corolla0001'");
    await counters.refreshAll();
    expect((await counters.readAll()).get('videos.live')).toBe(Number(before) - 1);
    await counters.sampleGrowth();
    expect(await db.record(() => counters.sampleGrowth())).toHaveLength(1);
  } finally {
    db.close();
  }
});

it('claims a cron slot only once, including concurrent duplicate delivery', async () => {
  const db = await createTestDatabase();
  try {
    const repository = new MaintenanceRepository(db);
    expect(
      await Promise.all([repository.claimSlot(3_600_000), repository.claimSlot(3_600_000)]),
    ).toEqual([true, false]);
    expect(await repository.claimSlot(7_200_000)).toBe(true);
    expect(await repository.claimSlot(3_600_000)).toBe(false);
  } finally {
    db.close();
  }
});
