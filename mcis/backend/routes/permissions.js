const express = require('express');
const router = express.Router();
const { grantPermission } = require('../security-engine/permissions');
const { resumePlan } = require('../backend-routing/taskPlanner');

router.post('/grant', async (req, res) => {
  const userId = 'test-user-123';
  const { resource } = req.body;

  if (!resource) {
    return res.status(400).json({ error: 'resource required' });
  }

  try {
    if (resource.startsWith('plan:')) {
      const planId = resource.replace('plan:', '');
      const result = await resumePlan(planId);
      return res.json(result);
    }

    const result = await grantPermission(userId, resource);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;