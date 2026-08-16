const axios = require('axios');

const NEXUS_URL = process.env.NEXUS_URL || 'http://localhost:8000';

async function sendCommandToNexus({ platform, action, parameters = {}, target = {}, value = null, approval_token = null }) {
  try {
    const response = await axios.post(`${NEXUS_URL}/execute`, {
      platform,
      action,
      parameters,
      target,
      value,
      approval_token,
    }, { timeout: 30000 });

    return response.data;
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.detail || error.message,
    };
  }
}

module.exports = { sendCommandToNexus };