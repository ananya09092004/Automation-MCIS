const axios = require('axios');
const NEXUS_URL = process.env.NEXUS_URL || 'http://localhost:8000';
const NEXUS_DEVICE_TOKEN = process.env.NEXUS_DEVICE_TOKEN || '';

async function sendCommandToNexus({ platform, action, parameters = {}, target = {}, value = null, approval_token = null }) {
  try {
    const response = await axios.post(`${NEXUS_URL}/execute`, {
      platform,
      action,
      parameters,
      target,
      value,
      approval_token,
    }, {
      timeout: 30000,
      headers: {
        'X-Device-Token': NEXUS_DEVICE_TOKEN
      }
    });
    return response.data;
  } catch (error) {
    if (error.response?.status === 401) {
      return {
        success: false,
        error: 'Nexus ne request reject ki (device token mismatch) — mcis/backend/.env aur nexus/.env dono me NEXUS_DEVICE_TOKEN same hona chahiye.',
      };
    }
    return {
      success: false,
      error: error.response?.data?.detail || error.message,
    };
  }
}

module.exports = { sendCommandToNexus };