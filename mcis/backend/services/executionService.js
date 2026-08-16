// backend/services/executionService.js

class ExecutionService {
  async executeCode(userId, code, language, timeout = 10000) {
    // 1. Validate code (no malicious patterns)
    if (this.isMalicious(code)) throw new Error('Unsafe code');
    
    // 2. Create sandbox
    const sandbox = new VM({
      timeout,
      sandbox: {
        console: { log: (...args) => this.logs.push(args) }
      }
    });
    
    // 3. Execute
    try {
      const result = sandbox.run(code);
      return { success: true, output: this.logs, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  
  isMalicious(code) {
    const banned = ['eval', 'require', 'fetch', 'fs', 'process'];
    return banned.some(b => code.includes(b));
  }
}

module.exports = new ExecutionService();