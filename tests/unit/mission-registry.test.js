import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MISSIONS, getMissionById } from '../../site/src/lib/experience/mission-registry.js';

test('mission registry: all 9 required missions exist with standard 8-stage lifecycle', () => {
  assert.equal(MISSIONS.length, 9);

  const requiredIds = [
    'integrate-public-asks',
    'complete-single-or-batch-purchase',
    'integrate-buyer-funded-offers',
    'protect-wallet-signing',
    'integrate-atomic-swaps',
    'operate-gateway-and-events',
    'verify-collection-and-attached-assets',
    'diagnose-protocol-failure',
    'perform-security-review'
  ];

  const standardStages = [
    'understand',
    'prepare',
    'simulate',
    'inspect',
    'verify',
    'integrate',
    'validate',
    'finish'
  ];

  for (const id of requiredIds) {
    const mission = getMissionById(id);
    assert.ok(mission, `Mission ${id} must be registered`);
    assert.ok(mission.title.length > 0);
    assert.ok(mission.plainEnglishGoal.length > 0);
    assert.ok(mission.prerequisites.length > 0);
    assert.ok(mission.completionCriteria.length > 0);

    // Verify all 8 standard stages in order
    assert.equal(mission.stages.length, 8, `Mission ${id} must have exactly 8 stages`);
    for (let i = 0; i < 8; i++) {
      assert.equal(mission.stages[i].id, standardStages[i], `Stage ${i} of ${id} must be ${standardStages[i]}`);
      assert.ok(mission.stages[i].title.length > 0);
      assert.ok(mission.stages[i].summaryTemplate.length > 0);
    }
  }
});
