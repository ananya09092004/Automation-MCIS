const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Create node (skill, project, goal, concept)
async function createNode(userId, nodeType, name, description = '', metadata = {}) {
  try {
    const { data, error } = await supabase
      .from('knowledge_nodes')
      .insert([{
        user_id: userId,
        node_type: nodeType,
        name,
        description,
        metadata,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select();

    if (error) throw error;
    logger.info(`Node created: ${nodeType}/${name}`);
    return { success: true, node: data[0] };
  } catch (err) {
    logger.error(`Create node error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Create relationship between nodes
async function createEdge(userId, fromNodeId, toNodeId, relationshipType, strength = 0.5) {
  try {
    const { data, error } = await supabase
      .from('knowledge_edges')
      .insert([{
        user_id: userId,
        from_node_id: fromNodeId,
        to_node_id: toNodeId,
        relationship_type: relationshipType,
        strength,
        created_at: new Date().toISOString()
      }])
      .select();

    if (error) throw error;
    logger.info(`Edge created: ${relationshipType}`);
    return { success: true, edge: data[0] };
  } catch (err) {
    logger.error(`Create edge error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Get user's entire knowledge graph
async function getUserKnowledgeGraph(userId) {
  try {
    const { data: nodes, error: nodesError } = await supabase
      .from('knowledge_nodes')
      .select('*')
      .eq('user_id', userId);

    const { data: edges, error: edgesError } = await supabase
      .from('knowledge_edges')
      .select('*')
      .eq('user_id', userId);

    if (nodesError || edgesError) throw nodesError || edgesError;

    return {
      success: true,
      nodes: nodes || [],
      edges: edges || [],
      totalNodes: nodes?.length || 0,
      totalEdges: edges?.length || 0
    };
  } catch (err) {
    logger.error(`Get graph error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Detect knowledge from conversation and auto-create nodes
async function extractKnowledgeFromMessage(userId, message) {
  try {
    const skills = detectSkills(message);
    const projects = detectProjects(message);
    const goals = detectGoals(message);

    const createdNodes = [];

    // Create skill nodes
    for (const skill of skills) {
      const { data } = await supabase
        .from('knowledge_nodes')
        .select('id')
        .eq('user_id', userId)
        .eq('node_type', 'skill')
        .eq('name', skill.name)
        .single();

      if (!data) {
        const result = await createNode(userId, 'skill', skill.name, '', { proficiency: skill.proficiency || 0.5 });
        if (result.success) createdNodes.push(result.node);
      }
    }

    // Create project nodes
    for (const project of projects) {
      const { data } = await supabase
        .from('knowledge_nodes')
        .select('id')
        .eq('user_id', userId)
        .eq('node_type', 'project')
        .eq('name', project.name)
        .single();

      if (!data) {
        const result = await createNode(userId, 'project', project.name, project.description);
        if (result.success) createdNodes.push(result.node);
      }
    }

    // Create goal nodes
    for (const goal of goals) {
      const { data } = await supabase
        .from('knowledge_nodes')
        .select('id')
        .eq('user_id', userId)
        .eq('node_type', 'goal')
        .eq('name', goal.name)
        .single();

      if (!data) {
        const result = await createNode(userId, 'goal', goal.name, goal.description);
        if (result.success) createdNodes.push(result.node);
      }
    }

    logger.info(`Knowledge extracted: ${createdNodes.length} nodes created`);
    return { success: true, nodes: createdNodes };
  } catch (err) {
    logger.error(`Extract knowledge error: ${err.message}`);
    return { success: false };
  }
}

// Detect skills from message
function detectSkills(message) {
  const skillKeywords = {
    'DSA': ['dsa', 'data structure', 'array', 'linked list', 'tree', 'graph', 'hash'],
    'Python': ['python', 'py'],
    'JavaScript': ['javascript', 'js', 'node', 'react'],
    'Backend': ['backend', 'server', 'api', 'express', 'fastapi'],
    'Frontend': ['frontend', 'react', 'vue', 'css', 'html'],
    'AI/ML': ['ai', 'ml', 'machine learning', 'deep learning', 'neural network', 'rag', 'vector'],
    'RAG': ['rag', 'retrieval augmented', 'vector search'],
    'Vector DB': ['vector db', 'pinecone', 'supabase pgvector'],
    'Firebase': ['firebase', 'authentication'],
    'PostgreSQL': ['postgresql', 'postgres', 'sql']
  };

  const detected = [];
  const lower = message.toLowerCase();

  for (const [skill, keywords] of Object.entries(skillKeywords)) {
    if (keywords.some(kw => lower.includes(kw))) {
      detected.push({ name: skill, proficiency: 0.5 });
    }
  }

  return detected;
}

// Detect projects
function detectProjects(message) {
  const projectKeywords = {
    'MCIS': ['mcis', 'memory centric', 'my project'],
    'HomeManager': ['homemanager', 'home manager'],
    'Building Tax': ['building tax', 'property tax']
  };

  const detected = [];
  const lower = message.toLowerCase();

  for (const [project, keywords] of Object.entries(projectKeywords)) {
    if (keywords.some(kw => lower.includes(kw))) {
      detected.push({ name: project, description: `User's project: ${project}` });
    }
  }

  return detected;
}

// Detect goals
function detectGoals(message) {
  const goalKeywords = {
    'AI Internship': ['ai internship', 'ai job'],
    'Build Startup': ['startup', 'product'],
    'Master DSA': ['master dsa', 'learn dsa'],
    'Learn RAG': ['learn rag', 'master rag']
  };

  const detected = [];
  const lower = message.toLowerCase();

  for (const [goal, keywords] of Object.entries(goalKeywords)) {
    if (keywords.some(kw => lower.includes(kw))) {
      detected.push({ name: goal, description: `User's goal: ${goal}` });
    }
  }

  return detected;
}

// Find knowledge gaps
async function findKnowledgeGaps(userId) {
  try {
    const graph = await getUserKnowledgeGraph(userId);
    const nodes = graph?.nodes || []; // FIX: on error getUserKnowledgeGraph returns {success:false} with no `nodes` — was crashing here
    const gaps = [];

    // If user has 'AI Internship' goal but no 'ML' skill
    const goals = nodes.filter(n => n.node_type === 'goal');
    const skills = nodes.filter(n => n.node_type === 'skill');

    for (const goal of goals) {
      if (goal.name.includes('AI') && !skills.find(s => s.name.includes('ML'))) {
        gaps.push({
          gap: 'Missing ML knowledge for AI goal',
          recommendation: 'Learn Machine Learning basics'
        });
      }
      if (goal.name.includes('Internship') && !skills.find(s => s.name.includes('DSA'))) {
        gaps.push({
          gap: 'DSA knowledge needed for internship',
          recommendation: 'Complete DSA fundamentals'
        });
      }
    }

    return { success: true, gaps };
  } catch (err) {
    logger.error(`Find gaps error: ${err.message}`);
    return { success: false };
  }
}

// Calculate node importance (centrality)
async function calculateCentrality(userId, nodeId) {
  try {
    const { data: edges } = await supabase
      .from('knowledge_edges')
      .select('*')
      .or(`from_node_id.eq.${nodeId},to_node_id.eq.${nodeId}`);

    const centrality = edges ? edges.length / 10 : 0; // Normalize

    return { success: true, centrality: Math.min(centrality, 1.0) };
  } catch (err) {
    logger.error(`Calculate centrality error: ${err.message}`);
    return { success: false };
  }
}

module.exports = {
  createNode,
  createEdge,
  getUserKnowledgeGraph,
  extractKnowledgeFromMessage,
  findKnowledgeGaps,
  calculateCentrality
};