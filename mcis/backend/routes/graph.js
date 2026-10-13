const express = require('express');
const router = express.Router();
const { 
  createNode, 
  createEdge, 
  getUserKnowledgeGraph,
  findKnowledgeGaps,
  calculateCentrality 
} = require('../services/knowledgeGraphService');
const logger = require('../services/logger');

// Get user's knowledge graph
router.get('/:userId', async (req, res) => {
  try {
    const result = await getUserKnowledgeGraph(req.params.userId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create node
router.post('/:userId/nodes', async (req, res) => {
  try {
    const { userId } = req.params;
    const { nodeType, name, description, metadata } = req.body;

    const result = await createNode(userId, nodeType, name, description, metadata);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create edge/relationship
router.post('/:userId/edges', async (req, res) => {
  try {
    const { userId } = req.params;
    const { fromNodeId, toNodeId, relationshipType, strength } = req.body;

    const result = await createEdge(userId, fromNodeId, toNodeId, relationshipType, strength || 0.5);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Find knowledge gaps
router.get('/:userId/gaps', async (req, res) => {
  try {
    const result = await findKnowledgeGaps(req.params.userId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Calculate node centrality
router.get('/:userId/nodes/:nodeId/centrality', async (req, res) => {
  try {
    const result = await calculateCentrality(req.params.userId, req.params.nodeId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;